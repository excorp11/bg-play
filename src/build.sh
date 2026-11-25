# Rebuild the speed-test engine (run in a Claude workspace).
# apt-get install -y emscripten ; git clone --depth 1 https://github.com/markbgsage/bgsage.git
# cube_patched.cpp = bgsage/cpp/src/cube.cpp plus, at the end:
#   extern "C" void te_reset_cache() { bgbot::begin_cubeful_cache_epoch(); }
R=bgsage/cpp; F="-std=c++17 -O3 -ffast-math -msimd128 -DNOMINMAX -I$R/include -I$R/src"
for s in board moves strategy pubeval game benchmark encoding neural_net training multipy rollout cube_eval match_equity bearoff cuda_nn_stub; do em++ $F -c $R/src/$s.cpp -o obj/$s.o; done
em++ $F -c cube_patched.cpp -o obj/cube_p.o; em++ $F -c tile_engine.cpp -o obj/te.o   # src/tile_engine.cpp.txt
em++ -O3 -msimd128 obj/*.o -o engine.js -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sENVIRONMENT=web,worker,node \
  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sTOTAL_STACK=16777216 \
  -sEXPORTED_FUNCTIONS=_te_create,_te_moves,_te_eval,_te_cube,_te_legal,_te_rollout_play,_te_rollout_cube,_te_free,_te_error,_te_reset_cache,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,stringToUTF8,lengthBytesUTF8
# weights-bundle.wasm + manifest.json: concatenate bgsage.weights.default_weights() nets, then bearoff_db_path(); offsets in manifest.
# The analyzer's index.html, worker.js and rules.md are the sources themselves (no build step).
