// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Mark Higgins
#include "bgbot/mobile.h"
#include "bgbot/bearoff.h"
#include "bgbot/board.h"
#include "bgbot/cube.h"
#include "bgbot/moves.h"
#include "bgbot/neural_net.h"
#include "bgbot/pubeval.h"
#include "bgbot/rollout.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <locale>
#include <memory>
#include <sstream>
#include <stdexcept>

using namespace bgbot;
struct BgsageMobileEngine {
    BearoffDB db;
    std::shared_ptr<Strategy> base;
    std::shared_ptr<Strategy> strategy;
};
namespace {
thread_local std::string last_error;
struct Move { Board board; std::array<double, 5> probs; double equity, cubeless; };
std::array<double, 5> widen(const std::array<float, 5>& p) {
    return {p[0], p[1], p[2], p[3], p[4]};
}
std::array<double, 5> invert(const std::array<float, 5>& p) {
    return {1.0-p[0], p[3], p[4], p[1], p[2]};
}
double cl(const std::array<double,5>& p) { return 2*p[0]-1+p[1]-p[3]+p[2]-p[4]; }
template<typename T, size_t N> void array(std::ostringstream& s, const std::array<T,N>& a) {
    s << '[';
    for(size_t i=0;i<N;++i) { if(i) s << ','; s << a[i]; }
    s << ']';
}
void validate(const BgsageMobileRequest& r, int operation) {
    if(operation<0 || operation>1 || r.ply<1 || r.ply>5 || r.cube_owner<0 || r.cube_owner>2 ||
       r.cube_value<1 || r.cube_value>32768 || (r.cube_value & (r.cube_value-1)) ||
       r.away1<0 || r.away2<0 || r.away1>25 || r.away2>25 ||
       ((r.away1==0)!=(r.away2==0)) || r.budget_ms<1 || r.budget_ms>2000000000 ||
       (operation==0 && (r.die1<1 || r.die1>6 || r.die2<1 || r.die2>6)))
        throw std::invalid_argument("unsupported request");
    int player=r.board[25], opponent=r.board[0];
    if(player<0 || opponent<0 || player>15 || opponent>15) throw std::invalid_argument("invalid bar");
    for(int i=1;i<25;++i) {
        if(r.board[i]<-15 || r.board[i]>15) throw std::invalid_argument("invalid checker count");
        if(r.board[i]>0) player+=r.board[i]; else opponent-=r.board[i];
    }
    if(player<1 || player>15 || opponent<1 || opponent>15)
        throw std::invalid_argument("invalid or terminal board");
}
}
extern "C" BgsageMobileEngine* bgsage_mobile_create(const char* type,
    const char* const* paths, const int* hidden, int count, const char* bearoff) {
    try {
        if(!type || !paths || !hidden || !bearoff || count<5 || count>32)
            throw std::invalid_argument("invalid model configuration");
        auto e=std::make_unique<BgsageMobileEngine>();
        std::vector<std::string> p; std::vector<int> h;
        for(int i=0;i<count;++i) { if(!paths[i] || hidden[i]<1 || hidden[i]>4096) throw std::invalid_argument("invalid model asset"); p.emplace_back(paths[i]); h.push_back(hidden[i]); }
        const std::string t(type);
        if(t=="backgame_pair_phased") e->base=std::make_shared<BackgameAwarePairStrategy>(p,h,true);
        else if(t=="backgame_pair") e->base=std::make_shared<BackgameAwarePairStrategy>(p,h);
        else if(t=="pair") e->base=std::make_shared<GamePlanPairStrategy>(p,h);
        else if(t=="5nn") e->base=std::make_shared<GamePlanStrategy>(p,h);
        else throw std::invalid_argument("unsupported model strategy");
        if(!e->db.load(bearoff)) throw std::runtime_error("bearoff asset unavailable");
        e->strategy=std::make_shared<BearoffStrategy>(e->base,&e->db);
        last_error.clear(); return e.release();
    } catch(const std::exception& ex) { last_error=ex.what(); return nullptr; }
    catch(...) { last_error="engine initialization failed"; return nullptr; }
}
extern "C" void bgsage_mobile_destroy(BgsageMobileEngine* e) { delete e; }
extern "C" void bgsage_mobile_free(char* p) { std::free(p); }
extern "C" const char* bgsage_mobile_last_error() { return last_error.c_str(); }

extern "C" char* bgsage_mobile_analyze(BgsageMobileEngine* e, int operation,
    const BgsageMobileRequest* request) {
    try {
        if(!e || !request) throw std::invalid_argument("engine unavailable");
        const auto& r=*request; validate(r,operation);
        Board board{}; std::copy(r.board,r.board+26,board.begin());
        CubeInfo ci{r.cube_value,static_cast<CubeOwner>(r.cube_owner),
            {r.away1,r.away2,r.is_crawford!=0},-1.0f,
            r.away1==0 && r.jacoby!=0,r.away1==0 && r.beaver!=0};
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(r.budget_ms);
        const auto check_budget=[&] { if(std::chrono::steady_clock::now()>deadline) throw std::runtime_error("native budget exceeded"); };
        std::ostringstream s; s.imbue(std::locale::classic()); s << std::setprecision(17) << std::boolalpha;
        const MoveFilter filter{5,0.08f};
        if(operation==0) {
            std::vector<Board> candidates; possible_boards(board,r.die1,r.die2,candidates);
            std::vector<Move> moves;
            for(const auto& b:candidates) {
                check_budget(); Move m{}; m.board=b;
                if(r.ply==1) {
                    auto p=e->strategy->evaluate_probs(b,board); m.probs=widen(p);
                    auto [pp,op]=pip_counts(b); const auto x=cube_efficiency(p,is_race(b),pp,op);
                    m.equity=cl2cf(p,ci,x);
                } else {
                    // Mirrors BgBotAnalyzer's cube-aware rescore of EVERY
                    // candidate, including root routing and flipped match state.
                    auto v=cubeful_probs_and_equity_nply(flip(b),flip_cube_perspective(ci),
                        *e->strategy,r.ply,filter,1,nullptr,&board);
                    m.probs=invert(v.probs); m.equity=-v.equity;
                }
                m.cubeless=cl(m.probs); moves.push_back(m);
            }
            std::sort(moves.begin(),moves.end(),[](const Move& a,const Move& b) {
                if(a.equity!=b.equity) return a.equity>b.equity;
                if(a.cubeless!=b.cubeless) return a.cubeless>b.cubeless;
                return a.board<b.board;
            });
            s << "{\"moves\":[";
            for(size_t i=0;i<moves.size();++i) { const auto& m=moves[i]; if(i) s << ',';
                s << "{\"board\":"; array(s,m.board); s << ",\"probs\":"; array(s,m.probs);
                s << ",\"equity\":" << m.equity << ",\"cubeless_equity\":" << m.cubeless
                  << ",\"equity_diff\":" << m.equity-moves[0].equity << ",\"eval_level\":\"" << r.ply << "-ply\"}";
            } s << "]}";
        } else {
            std::array<float,5> p; CubeDecision cd;
            if(r.ply==1) {
                p=invert_probs(e->strategy->evaluate_probs(flip(board),is_race(board)));
                auto [pp,op]=pip_counts(board);
                cd=cube_decision_1ply(p,ci,cube_efficiency(p,is_race(board),pp,op));
            } else {
                PubEval prefilter;
                cd=cube_decision_nply(board,ci,*e->strategy,r.ply,filter,1,&prefilter);
                check_budget();
                MultiPlyStrategy multipy(e->strategy,r.ply,filter,false,false,1);
                multipy.set_bearoff_db(&e->db);
                const Board flipped=flip(board);
                p=invert_probs(multipy.evaluate_probs(flipped,flipped)); multipy.clear_cache();
            }
            const char* action=!cd.should_double ? "No Double" : cd.is_beaver ? "Double/Beaver" : cd.should_take ? "Double/Take" : "Double/Pass";
            s << "{\"probs\":"; array(s,p);
            s << ",\"cubeless_equity\":" << cubeless_equity(p)
              << ",\"equity_nd\":" << cd.equity_nd << ",\"equity_dt\":" << cd.equity_dt
              << ",\"equity_dp\":" << cd.equity_dp << ",\"should_double\":" << cd.should_double
              << ",\"should_take\":" << cd.should_take << ",\"optimal_equity\":" << cd.optimal_equity
              << ",\"optimal_action\":\"" << action << "\",\"is_beaver\":" << cd.is_beaver
              << ",\"eval_level\":\"" << r.ply << "-ply\",\"cubeless_se\":null,\"equity_nd_se\":null,\"equity_dt_se\":null}";
        }
        check_budget(); auto text=s.str(); char* out=static_cast<char*>(std::malloc(text.size()+1));
        if(!out) throw std::bad_alloc(); std::memcpy(out,text.c_str(),text.size()+1);
        last_error.clear(); return out;
    } catch(const std::exception& ex) { last_error=ex.what(); return nullptr; }
    catch(...) { last_error="native evaluation failed"; return nullptr; }
}


// ---- Tile engine API (one engine per WebAssembly instance / web worker) ----
#ifdef __EMSCRIPTEN__
EM_JS(void, te_js_progress, (int done, int total), {
  if (typeof self !== 'undefined' && self.__teProgress) self.__teProgress(done, total);
});
#else
static void te_js_progress(int, int) {}
#endif
static BgsageMobileEngine* g_engine=nullptr;
static char* dup_str(const std::string& t){ char* o=(char*)std::malloc(t.size()+1); std::memcpy(o,t.c_str(),t.size()+1); return o; }
// owner: 0 centred, 1 the side on roll owns, 2 the opponent owns. away1/away2 = 0 for money.
static CubeInfo make_ci(int cube_value,int cube_owner,int jacoby,int beaver,int away1,int away2,int crawford){
    bool money = away1==0;
    return CubeInfo{cube_value,static_cast<CubeOwner>(cube_owner),{away1,away2,crawford!=0},-1.0f,money && jacoby!=0,money && beaver!=0};
}
static Board to_board(const int* b26){ Board b{}; std::copy(b26,b26+26,b.begin()); return b; }
template<typename T> static void arr(std::ostringstream& s,const T& a){ s<<'['; for(size_t i=0;i<a.size();++i){ if(i) s<<','; s<<a[i]; } s<<']'; }
static std::string num(double v){ std::ostringstream s; s.imbue(std::locale::classic()); s<<std::setprecision(6)<<v; return s.str(); }
extern "C" {
int te_create(const char* type,const char* paths,const char* hidden,const char* bearoff){
    std::vector<std::string> ps; std::vector<int> hs; std::string cur;
    for(const char* c=paths;;++c){ if(*c=='\n'||*c==0){ if(!cur.empty()) ps.push_back(cur); cur.clear(); if(!*c) break; } else cur+=*c; }
    for(const char* c=hidden;;++c){ if(*c==','||*c==0){ if(!cur.empty()) hs.push_back(std::atoi(cur.c_str())); cur.clear(); if(!*c) break; } else cur+=*c; }
    if(ps.size()!=hs.size()) { last_error="paths/hidden mismatch"; return 0; }
    std::vector<const char*> pc; for(auto& x:ps) pc.push_back(x.c_str());
    g_engine=bgsage_mobile_create(type,pc.data(),hs.data(),(int)pc.size(),bearoff);
    return g_engine?1:0;
}
const char* te_error(){ return last_error.c_str(); }
void te_free(char* p){ std::free(p); }
// Legal plays only (distinct resulting boards), no evaluation.
char* te_legal(const int* b26,int d1,int d2){
    try{ Board board=to_board(b26); std::vector<Board> c; possible_boards(board,d1,d2,c);
        std::ostringstream s; s<<'['; for(size_t i=0;i<c.size();++i){ if(i) s<<','; arr(s,c[i]); } s<<']'; return dup_str(s.str());
    }catch(const std::exception& ex){ last_error=ex.what(); return nullptr; }
}
// All legal plays scored at 1-ply cubeful (mover's view, post-move probs), best first.
char* te_moves(const int* b26,int d1,int d2,int cv,int co,int jac,int bea,int a1,int a2,int cr){
    try{
        Board board=to_board(b26); CubeInfo ci=make_ci(cv,co,jac,bea,a1,a2,cr);
        std::vector<Board> cands; possible_boards(board,d1,d2,cands);
        struct M{double e; Board b; std::array<float,5> p;}; std::vector<M> v;
        for(auto& b:cands){ auto p=g_engine->strategy->evaluate_probs(b,board); auto [pp,op]=pip_counts(b);
            v.push_back({(double)cl2cf(p,ci,cube_efficiency(p,is_race(b),pp,op)),b,p}); }
        std::sort(v.begin(),v.end(),[](const M&a,const M&b){return a.e>b.e;});
        std::ostringstream s; s.imbue(std::locale::classic()); s<<std::setprecision(6)<<'[';
        for(size_t i=0;i<v.size();++i){ if(i) s<<','; s<<"{\"b\":"; arr(s,v[i].b); s<<",\"e\":"<<v[i].e<<",\"p\":"; arr(s,v[i].p); s<<'}'; }
        s<<']'; return dup_str(s.str());
    }catch(const std::exception& ex){ last_error=ex.what(); return nullptr; }
}
// One post-move position at N-ply (2+), cube-aware: BgBotAnalyzer.checker_play's per-play rescore.
char* te_eval(const int* b26,const int* cand26,int ply,int cv,int co,int jac,int bea,int a1,int a2,int cr){
    try{
        Board board=to_board(b26), b=to_board(cand26); CubeInfo ci=make_ci(cv,co,jac,bea,a1,a2,cr);
        const MoveFilter filter{5,0.08f};
        auto v=cubeful_probs_and_equity_nply(flip(b),flip_cube_perspective(ci),*g_engine->strategy,ply,filter,1,nullptr,&board);
        auto p=invert(v.probs);
        std::ostringstream s; s.imbue(std::locale::classic()); s<<std::setprecision(7)<<"{\"e\":"<<-v.equity<<",\"p\":"; arr(s,p); s<<"}";
        return dup_str(s.str());
    }catch(const std::exception& ex){ last_error=ex.what(); return nullptr; }
}
// Cube decision for the side on roll at N-ply (1-5).
char* te_cube(const int* b26,int ply,int cv,int co,int jac,int bea,int a1,int a2,int cr){
    BgsageMobileRequest r{}; std::copy(b26,b26+26,r.board); r.die1=1; r.die2=1; r.ply=ply;
    r.cube_value=cv; r.cube_owner=co; r.jacoby=jac; r.beaver=bea; r.away1=a1; r.away2=a2; r.is_crawford=cr; r.budget_ms=2000000000;
    return bgsage_mobile_analyze(g_engine,1,&r);
}
// Rollouts. preset 1 = 1T (trunc 5, 1-ply), 2 = 2T-like, 3 = 3T (trunc 7, 3-ply early, 2-ply late; ~XG Roller++).
static std::shared_ptr<RolloutStrategy> make_rollout(int preset,int n_trials,unsigned seed){
    RolloutConfig rc; rc.n_trials=n_trials; rc.n_threads=1; rc.parallelize_trials=false; rc.seed=seed; rc.filter={5,0.08f};
    if(preset==1){ rc.truncation_depth=5; rc.decision_ply=1; rc.ultra_late_threshold=2; }
    else if(preset==2){ rc.truncation_depth=7; rc.decision_ply=2; rc.truncation_ply=2; rc.late_ply=1; rc.late_threshold=1;
        rc.cube=TrialEvalConfig{2,0,5,1}; rc.cube_late=TrialEvalConfig{2,0,5,1}; rc.ultra_late_threshold=9999; }
    else { rc.truncation_depth=7; rc.decision_ply=3; rc.late_ply=2; rc.late_threshold=2; rc.ultra_late_threshold=9999; }
    auto r=std::make_shared<RolloutStrategy>(g_engine->base,rc);
    r->set_bearoff_db(&g_engine->db);
    return r;
}
char* te_rollout_play(const int* post26,int preset,int n_trials,int seed,int cv,int co,int jac,int bea,int a1,int a2,int cr){
    try{
        Board b=to_board(post26); CubeInfo ci=make_ci(cv,co,jac,bea,a1,a2,cr);
        auto r=make_rollout(preset,n_trials,(unsigned)seed);
        auto res=r->cubeful_rollout_position(b,ci,[](int d,int t){ te_js_progress(d,t); });
        std::ostringstream s; s.imbue(std::locale::classic()); s<<std::setprecision(7)<<"{\"e\":"<<res.cubeful_equity<<",\"se\":"<<res.cubeful_se<<",\"p\":"; arr(s,res.cubeless.mean_probs); s<<"}";
        return dup_str(s.str());
    }catch(const std::exception& ex){ last_error=ex.what(); return nullptr; }
}
char* te_rollout_cube(const int* b26,int preset,int n_trials,int seed,int cv,int co,int jac,int bea,int a1,int a2,int cr){
    try{
        Board b=to_board(b26); CubeInfo ci=make_ci(cv,co,jac,bea,a1,a2,cr);
        auto r=make_rollout(preset,n_trials,(unsigned)seed);
        auto res=r->cubeful_cube_decision(b,ci,[](int d,int t){ te_js_progress(d,t); });
        std::ostringstream s; s.imbue(std::locale::classic()); s<<std::setprecision(7)<<"{\"nd\":"<<res.nd_equity<<",\"nd_se\":"<<res.nd_se<<",\"dt\":"<<res.dt_equity<<",\"dt_se\":"<<res.dt_se<<",\"p\":"; arr(s,res.cubeless.mean_probs); s<<"}";
        return dup_str(s.str());
    }catch(const std::exception& ex){ last_error=ex.what(); return nullptr; }
}
}
