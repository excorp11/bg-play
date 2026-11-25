#!/usr/bin/env python3
# Patch Open Sage's cpp/src/neural_net.cpp for the WebAssembly build: give the hidden layer the same Cephes sigmoid the
# x86 (AVX2) build uses, 4 lanes at a time with WebAssembly SIMD. Without it a build with neither AVX2 nor NEON falls
# back to the lookup-table sigmoid, whose interpolation error moved win probabilities by up to 0.0015 and 2-3-ply
# equities by up to 0.006 against the Python package (found 2026-11-25). WebAssembly SIMD has no fused multiply-add,
# so each FMA of the AVX2 code is a multiply then an add (results within an ulp or two).
# usage: python3 wasm_sigmoid.py <bgsage>/cpp/src/neural_net.cpp <out.cpp>
import re, sys
src = open(sys.argv[1]).read()
FUNCS = r'''
#if !defined(BGBOT_USE_AVX2) && defined(__wasm_simd128__)
#include <wasm_simd128.h>
#define BGBOT_USE_WASM_SIGMOID 1
// WebAssembly port of exp256_ps / sigmoid256_ps above (the tiles' build; see wasm_sigmoid.py).
static inline v128_t exp128_ps(v128_t x) {
    const v128_t one    = wasm_f32x4_splat(1.0f);
    const v128_t half   = wasm_f32x4_splat(0.5f);
    const v128_t exp_hi = wasm_f32x4_splat(88.3762626647949f);
    const v128_t exp_lo = wasm_f32x4_splat(-88.3762626647949f);
    const v128_t log2e  = wasm_f32x4_splat(1.44269504088896341f);
    const v128_t c1     = wasm_f32x4_splat(0.693359375f);
    const v128_t c2     = wasm_f32x4_splat(-2.12194440e-4f);
    const v128_t p0     = wasm_f32x4_splat(1.9875691500E-4f);
    const v128_t p1     = wasm_f32x4_splat(1.3981999507E-3f);
    const v128_t p2     = wasm_f32x4_splat(8.3334519073E-3f);
    const v128_t p3     = wasm_f32x4_splat(4.1665795894E-2f);
    const v128_t p4     = wasm_f32x4_splat(1.6666665459E-1f);
    const v128_t p5     = wasm_f32x4_splat(5.0000001201E-1f);
    x = wasm_f32x4_min(x, exp_hi);
    x = wasm_f32x4_max(x, exp_lo);
    v128_t fx = wasm_f32x4_floor(wasm_f32x4_add(wasm_f32x4_mul(x, log2e), half));
    x = wasm_f32x4_sub(x, wasm_f32x4_mul(fx, c1));
    x = wasm_f32x4_sub(x, wasm_f32x4_mul(fx, c2));
    const v128_t z = wasm_f32x4_mul(x, x);
    v128_t y = wasm_f32x4_add(wasm_f32x4_mul(p0, x), p1);
    y = wasm_f32x4_add(wasm_f32x4_mul(y, x), p2);
    y = wasm_f32x4_add(wasm_f32x4_mul(y, x), p3);
    y = wasm_f32x4_add(wasm_f32x4_mul(y, x), p4);
    y = wasm_f32x4_add(wasm_f32x4_mul(y, x), p5);
    y = wasm_f32x4_add(wasm_f32x4_mul(y, z), x);
    y = wasm_f32x4_add(y, one);
    v128_t n = wasm_i32x4_trunc_sat_f32x4(fx);
    n = wasm_i32x4_shl(wasm_i32x4_add(n, wasm_i32x4_splat(0x7f)), 23);
    return wasm_f32x4_mul(y, n);
}
static inline v128_t sigmoid128_ps(v128_t x) {
    const v128_t one = wasm_f32x4_splat(1.0f);
    return wasm_f32x4_div(one, wasm_f32x4_add(one, exp128_ps(wasm_f32x4_neg(x))));
}
#endif
'''
# 1) the functions, right after the AVX2 sigmoid block
anchor = re.search(r'static inline __m256 sigmoid256_ps\(__m256 x\) \{.*?\n\}\n#endif\n', src, re.S)
assert anchor, 'sigmoid256_ps block not found'
src = src[:anchor.end()] + FUNCS + src[anchor.end():]
# 2) each hidden-layer loop: a 4-lane WebAssembly branch next to the 8-lane AVX2 one
pat = re.compile(r'#if defined\(BGBOT_USE_AVX2\)\n(?P<body>(?P<ind>[ \t]*)for \(; h \+ 7 < nh; h \+= 8\) \{\n[ \t]*__m256 v = _mm256_loadu_ps\(&hiddens\[h\]\);\n[ \t]*_mm256_storeu_ps\(&hiddens\[h\], sigmoid256_ps\(v\)\);\n[ \t]*\}\n)#endif\n')
n = 0
def sub(m):
    global n; n += 1; i = m.group('ind')
    return (f"#if defined(BGBOT_USE_AVX2)\n{m.group('body')}#elif defined(BGBOT_USE_WASM_SIGMOID)\n"
            f"{i}for (; h + 3 < nh; h += 4) wasm_v128_store(&hiddens[h], sigmoid128_ps(wasm_v128_load(&hiddens[h])));\n#endif\n")
src = pat.sub(sub, src)
assert n >= 3, f'only {n} hidden-layer loops patched'
open(sys.argv[2], 'w').write(src)
print(f'{sys.argv[2]}: WebAssembly sigmoid added to {n} hidden-layer loops')
