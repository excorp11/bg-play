#!/bin/bash
# Build the tiles' Open Sage engine (engine.js + engine.wasm) from a bgsage source tree (run in a Claude workspace).
# Current build (2026-11-25): bgsage v2.1.20261122 (tag; https://github.com/markbgsage/bgsage), ENGINE_V 2.1.20261122.1.
#   apt-get install -y emscripten        # Ubuntu's 3.1.6 (the emsdk download is blocked)
#   git init s && cd s && git remote add origin https://github.com/markbgsage/bgsage &&
#     git fetch --depth 1 --filter=blob:limit=1m origin refs/tags/v2.1.20261122 && git checkout FETCH_HEAD
#   ./build.sh s out                     # out/engine.js + out/engine.wasm (a pair: always publish both)
# Changes to Open Sage's own files (MPL-2.0), made here at build time:
#   cube.cpp       + extern "C" void te_reset_cache() { bgbot::begin_cubeful_cache_epoch(); }
#   neural_net.cpp + the AVX2 build's Cephes sigmoid for the hidden layer, 4 lanes with WebAssembly SIMD (wasm_sigmoid.py).
#                    Without it a build with neither AVX2 nor NEON uses the lookup-table sigmoid, whose interpolation
#                    error moved equities by up to 0.006 against the Python package; with it they agree to about 1e-6.
# tile_engine.cpp is the tiles' API (te_*), compiled with the engine. The weights (weights-bundle.wasm + manifest.json)
# are built separately (mkbundle.py) and only change when bgsage's networks do.
# usage: build.sh <bgsage checkout> <out dir> [lut]   (lut: keep the lookup-table sigmoid, for comparison)
# TE=<file> builds another tile_engine.cpp (the speed test's v1 API) with EXPORTS=<its export list>.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); SRC=$(cd "$1" && pwd); OUT=$2; mkdir -p "$OUT/obj"; OUT=$(cd "$OUT" && pwd)
R=$SRC/cpp; F="-std=c++17 -O3 -ffast-math -msimd128 -DNOMINMAX -I$R/include -I$R/src"
{ cat "$R/src/cube.cpp"; echo; echo 'extern "C" void te_reset_cache() { bgbot::begin_cubeful_cache_epoch(); }'; } > "$OUT/cube_patched.cpp"
if [ "$3" = lut ]; then cp "$R/src/neural_net.cpp" "$OUT/neural_net_patched.cpp"; else python3 "$HERE/wasm_sigmoid.py" "$R/src/neural_net.cpp" "$OUT/neural_net_patched.cpp"; fi
jobs=()
for s in board moves strategy pubeval game benchmark encoding training multipy rollout cube_eval match_equity bearoff cuda_nn_stub; do
  em++ $F -c "$R/src/$s.cpp" -o "$OUT/obj/$s.o" & jobs+=($!)
  if [ ${#jobs[@]} -ge 2 ]; then wait ${jobs[0]}; jobs=("${jobs[@]:1}"); fi
done
wait
em++ $F -c "$OUT/neural_net_patched.cpp" -o "$OUT/obj/neural_net.o"
em++ $F -c "$OUT/cube_patched.cpp" -o "$OUT/obj/cube_p.o"
em++ $F -c "${TE:-$HERE/tile_engine.cpp}" -o "$OUT/obj/te.o"
em++ -O3 -msimd128 "$OUT"/obj/*.o -o "$OUT/engine.js" -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sENVIRONMENT=web,worker,node \
  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sTOTAL_STACK=16777216 \
  -sEXPORTED_FUNCTIONS=${EXPORTS:-_te_create,_te_moves,_te_eval,_te_cube,_te_legal,_te_rollout_play,_te_rollout_cube,_te_free,_te_error,_te_reset_cache,_malloc,_free} \
  -sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,stringToUTF8,lengthBytesUTF8
ls -l "$OUT/engine.js" "$OUT/engine.wasm" | awk '{print $5, $9}'
