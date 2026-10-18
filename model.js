// Turns a FRONT and a BACK picture into a puffy 3D "plush" model.
//
//  1. Find the silhouette of the front picture (alpha channel, or the line art /
//     colored shape on a plain background; closed outlines get filled in).
//  2. Inflate it into a pillow: the farther a point is from the edge, the thicker it is.
//  3. Front picture -> front face, back picture (mirrored) -> back face.
//  4. The most common color of both pictures colors the sides (left / right rim).
//
// Usage: const { mesh, radius, samples } = buildPlush(front, back)
//        front / back = { image: HTMLImageElement, ... } from upload.js

import * as TH from './build/three.module.js'

const TARGET_SIZE = 6.4;   // longest side of the model in world units (the ball is 6 wide)
const ANALYSIS_MAX = 256;  // pictures are analysed at this size (px)
// mesh density: one vertex every N analysis pixels (denser = smoother shading and squishing).
// Phones / tablets (touch screens) get a lighter mesh so they stay smooth.
const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const GRID_STEP = IS_TOUCH ? 2 : 1;
const PAD = 4;             // empty margin (px) around the silhouette
const PUFF = 0.6;          // thickness: half-depth = PUFF x the widest "inscribed circle" radius

// ------------------------------------------------------------------
// Small image-processing helpers (all work on flat Uint8/Float32 arrays)
// ------------------------------------------------------------------

function invert(src) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i] ? 0 : 1;
    return out;
}

// Square dilation (grow white areas by r pixels), separable using prefix sums
function dilate(src, w, h, r) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    const pre = new Int32Array(Math.max(w, h) + 1);
    for (let y = 0; y < h; y++) {
        pre[0] = 0;
        for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[y * w + x];
        for (let x = 0; x < w; x++) {
            const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
            tmp[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
        }
    }
    for (let x = 0; x < w; x++) {
        pre[0] = 0;
        for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
        for (let y = 0; y < h; y++) {
            const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
            out[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
        }
    }
    return out;
}

const erode = (src, w, h, r) => invert(dilate(invert(src), w, h, r));

// Which pixels can be reached from the image border without crossing a wall?
function floodOutside(walls, w, h) {
    const out = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (i) => {
        if (!walls[i] && !out[i]) { out[i] = 1; queue[tail++] = i; }
    };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (y > 0) push(i - w);
        if (y < h - 1) push(i + w);
    }
    return out;
}

// Keep only the biggest connected blob (removes specks)
function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    let best = 0, bestId = 0, id = 0;
    for (let s = 0; s < w * h; s++) {
        if (!mask[s] || label[s]) continue;
        id++;
        let head = 0, tail = 0;
        queue[tail++] = s;
        label[s] = id;
        while (head < tail) {
            const i = queue[head++];
            const x = i % w;
            const y = (i - x) / w;
            const tryPush = (j) => {
                if (mask[j] && !label[j]) { label[j] = id; queue[tail++] = j; }
            };
            if (x > 0) tryPush(i - 1);
            if (x < w - 1) tryPush(i + 1);
            if (y > 0) tryPush(i - w);
            if (y < h - 1) tryPush(i + w);
        }
        if (tail > best) { best = tail; bestId = id; }
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = label[i] === bestId ? 1 : 0;
    return out;
}

function maskBox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return null;
    return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Two-pass chamfer distance transform: distance to the nearest "source" pixel
function distanceTo(sources, w, h) {
    const INF = 1e9, A = 1, B = Math.SQRT2;
    const d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = sources[i] ? 0 : INF;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            let v = d[i];
            if (x > 0) v = Math.min(v, d[i - 1] + A);
            if (y > 0) {
                v = Math.min(v, d[i - w] + A);
                if (x > 0) v = Math.min(v, d[i - w - 1] + B);
                if (x < w - 1) v = Math.min(v, d[i - w + 1] + B);
            }
            d[i] = v;
        }
    }
    for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
            const i = y * w + x;
            let v = d[i];
            if (x < w - 1) v = Math.min(v, d[i + 1] + A);
            if (y < h - 1) {
                v = Math.min(v, d[i + w] + A);
                if (x < w - 1) v = Math.min(v, d[i + w + 1] + B);
                if (x > 0) v = Math.min(v, d[i + w - 1] + B);
            }
            d[i] = v;
        }
    }
    return d;
}

function blurFloat(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const pre = new Float64Array(Math.max(w, h) + 1);
    for (let y = 0; y < h; y++) {
        pre[0] = 0;
        for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[y * w + x];
        for (let x = 0; x < w; x++) {
            const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
            tmp[y * w + x] = (pre[b] - pre[a]) / (b - a);
        }
    }
    for (let x = 0; x < w; x++) {
        pre[0] = 0;
        for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
        for (let y = 0; y < h; y++) {
            const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
            out[y * w + x] = (pre[b] - pre[a]) / (b - a);
        }
    }
    return out;
}

// Signed distance to the silhouette edge: positive inside, negative outside (in pixels)
function computeSdf(mask, w, h) {
    const dIn = distanceTo(invert(mask), w, h);  // inside pixels -> nearest outside pixel
    const dOut = distanceTo(mask, w, h);         // outside pixels -> nearest inside pixel
    let sdf = new Float32Array(w * h);
    for (let i = 0; i < sdf.length; i++) {
        sdf[i] = mask[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
    }
    sdf = blurFloat(sdf, w, h, 2);   // smooth the stair-steps
    sdf = blurFloat(sdf, w, h, 2);
    return sdf;
}

function sampleBilinear(arr, w, h, x, y) {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = arr[y0 * w + x0] * (1 - fx) + arr[y0 * w + x1] * fx;
    const b = arr[y1 * w + x0] * (1 - fx) + arr[y1 * w + x1] * fx;
    return a * (1 - fy) + b * fy;
}

// ------------------------------------------------------------------
// Picture analysis: silhouette mask + colors
// ------------------------------------------------------------------

// Most common color along the picture's border = the background color
function borderColor(data, w, h) {
    const counts = new Map();
    const add = (x, y) => {
        const i = (y * w + x) * 4;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        let e = counts.get(key);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(key, e); }
        e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
    let best = null;
    counts.forEach((e) => { if (!best || e.n > best.n) best = e; });
    return [best.r / best.n, best.g / best.n, best.b / best.n];
}

// "ink" = anything that isn't background (the lines of the drawing).
// The outside is flood-filled from the border; whatever the flood can't reach is the shape.
// Lines are thickened first so small gaps in the outline don't leak.
function silhouetteFromInk(ink, w, h) {
    const box = maskBox(ink, w, h);
    if (!box) return new Uint8Array(w * h).fill(1);
    const boxArea = box.w * box.h;
    for (const r of [2, 4, 7, 12]) {
        const walls = dilate(ink, w, h, r);
        const outside = floodOutside(walls, w, h);
        const mask = erode(invert(outside), w, h, r);
        let area = 0;
        for (let i = 0; i < mask.length; i++) area += mask[i];
        if (area > boxArea * 0.12) return largestComponent(mask, w, h);
    }
    // The outline is too broken to fill: fall back to the bounding box
    const m = new Uint8Array(w * h);
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) m[y * w + x] = 1;
    return m;
}

function analyzeImage(image) {
    const nw = image.naturalWidth || image.width;
    const nh = image.naturalHeight || image.height;
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(nw, nh));
    const w = Math.max(8, Math.round(nw * scale));
    const h = Math.max(8, Math.round(nh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;

    let transparent = 0;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 250) transparent++;

    let mask;
    if (transparent > n * 0.005) {
        // PNG with a transparent background: the alpha channel is the silhouette
        mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > 128 ? 1 : 0;
        mask = largestComponent(mask, w, h);
    } else {
        const bg = borderColor(data, w, h);
        const ink = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const dr = data[i * 4] - bg[0];
            const dg = data[i * 4 + 1] - bg[1];
            const db = data[i * 4 + 2] - bg[2];
            ink[i] = dr * dr + dg * dg + db * db > 50 * 50 ? 1 : 0;
        }
        mask = silhouetteFromInk(ink, w, h);
    }
    return { w, h, data, mask, box: maskBox(mask, w, h) };
}

// Most common (non-dark) color inside the shapes of all given pictures
function dominantColor(analyses) {
    const bins = new Map();
    analyses.forEach(({ data, mask }) => {
        for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
            if (a < 200) continue;
            if (0.299 * r + 0.587 * g + 0.114 * b < 60) continue; // skip dark outlines
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let e = bins.get(key);
            if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
            e.n++; e.r += r; e.g += g; e.b += b;
        }
    });
    let best = null;
    bins.forEach((e) => { if (!best || e.n > best.n) best = e; });
    if (!best) return [200, 200, 200];
    return [best.r / best.n, best.g / best.n, best.b / best.n];
}

function imageTexture(image) {
    const t = new TH.Texture(image);
    t.generateMipmaps = true;                  // no shimmering when the model is small or turning
    t.minFilter = TH.LinearMipmapLinearFilter;
    t.magFilter = TH.LinearFilter;
    t.anisotropy = 8;                          // sharp pictures even at steep viewing angles
    if (TH.SRGBColorSpace) t.colorSpace = TH.SRGBColorSpace;
    else if (TH.sRGBEncoding) t.encoding = TH.sRGBEncoding;
    t.needsUpdate = true;
    return t;
}

// ------------------------------------------------------------------
// Build the mesh
// ------------------------------------------------------------------

export function buildPlush(front, back) {
    const A = analyzeImage(front.image);
    const B = analyzeImage(back.image);
    if (!A.box) throw new Error('No shape found in the front picture');
    const fb = A.box;
    const bb = B.box || { x0: 0, y0: 0, w: B.w, h: B.h };

    // Silhouette of the front picture, cropped with a little empty margin
    const cw = fb.w + PAD * 2;
    const ch = fb.h + PAD * 2;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
        const sy = fb.y0 - PAD + y;
        if (sy < 0 || sy >= A.h) continue;
        for (let x = 0; x < cw; x++) {
            const sx = fb.x0 - PAD + x;
            if (sx < 0 || sx >= A.w) continue;
            crop[y * cw + x] = A.mask[sy * A.w + sx];
        }
    }
    const sdf = computeSdf(crop, cw, ch);
    // Extra-smooth copy, used only for the inside of the pillow: removes the sharp ridge
    // along the middle of the shape so the surface looks round and puffy.
    const sdfSoft = blurFloat(blurFloat(blurFloat(sdf, cw, ch, 5), cw, ch, 5), cw, ch, 5);
    let maxSdf = 4;
    for (let i = 0; i < sdf.length; i++) if (sdf[i] > maxSdf) maxSdf = sdf[i];

    const scale = TARGET_SIZE / Math.max(fb.w, fb.h);   // analysis px -> world units
    const halfDepth = PUFF * maxSdf * scale;

    // Smooth edge texture: 0.5 exactly on the silhouette edge. Pixels below 0.5 are cut away,
    // which gives a clean smooth outline even though the mesh grid is coarse.
    const maskData = new Uint8Array(cw * ch * 4);
    for (let i = 0; i < cw * ch; i++) {
        const v = Math.max(0, Math.min(1, 0.5 + sdf[i] / 16));
        const byte = Math.round(v * 255);
        maskData[i * 4] = byte;
        maskData[i * 4 + 1] = byte;
        maskData[i * 4 + 2] = byte;
        maskData[i * 4 + 3] = 255;
    }
    const maskTex = new TH.DataTexture(maskData, cw, ch, TH.RGBAFormat);
    maskTex.minFilter = TH.LinearFilter;
    maskTex.magFilter = TH.LinearFilter;
    maskTex.generateMipmaps = false;
    maskTex.needsUpdate = true;

    // Grid mesh: a front surface and a back surface that meet at the silhouette edge
    const gw = Math.ceil(cw / GRID_STEP) + 1;
    const gh = Math.ceil(ch / GRID_STEP) + 1;
    const nV = gw * gh;
    const pos = new Float32Array(nV * 2 * 3);
    const uvF = new Float32Array(nV * 2 * 2);
    const uvB = new Float32Array(nV * 2 * 2);
    const shape = new Float32Array(nV * 2 * 2);
    const side = new Float32Array(nV * 2);
    const rim = new Float32Array(nV * 2);
    const sdfV = new Float32Array(nV);
    const samples = [];

    for (let b = 0; b < gh; b++) {
        for (let a = 0; a < gw; a++) {
            const X = Math.min(a * GRID_STEP, cw);
            const Y = Math.min(b * GRID_STEP, ch);
            const s = sampleBilinear(sdf, cw, ch, X - 0.5, Y - 0.5);
            const idx = b * gw + a;
            sdfV[idx] = s;

            const x = (X - cw / 2) * scale;
            const y = -(Y - ch / 2) * scale;
            // Pillow profile: 0 at the edge, rises smoothly to 1 at the middle.
            // Continues linearly (negative) outside the edge so front and back cross exactly at the edge.
            // near the edge use the exact distance (front and back must meet there),
            // deeper inside blend toward the smooth version
            const sSoft = sampleBilinear(sdfSoft, cw, ch, X - 0.5, Y - 0.5);
            const t = Math.max(0, Math.min(1, s / (0.4 * maxSdf)));
            const sd = s + (sSoft - s) * t * t * (3 - 2 * t);
            const xn = sd / maxSdf;
            const g = xn <= 0 ? Math.max(2 * xn, -0.4) : (xn < 1 ? xn * (2 - xn) : 1);
            const z = halfDepth * g;

            // front picture coordinates
            const fu = (fb.x0 - PAD + X) / A.w;
            const fv = 1 - (fb.y0 - PAD + Y) / A.h;
            // back picture: mirrored left <-> right, matched by silhouette bounding box
            const fx = (X - PAD) / fb.w;
            const fy = (Y - PAD) / fb.h;
            const bu = (bb.x0 + (1 - fx) * bb.w) / B.w;
            const bv = 1 - (bb.y0 + fy * bb.h) / B.h;

            for (let k = 0; k < 2; k++) {
                const j = idx + k * nV;
                pos[j * 3] = x;
                pos[j * 3 + 1] = y;
                pos[j * 3 + 2] = k === 0 ? z : -z;
                uvF[j * 2] = fu; uvF[j * 2 + 1] = fv;
                uvB[j * 2] = bu; uvB[j * 2 + 1] = bv;
                shape[j * 2] = X / cw; shape[j * 2 + 1] = Y / ch;
                side[j] = k === 0 ? 1 : -1;
                rim[j] = xn;
            }
            if (s >= 0) samples.push(x, y, z, x, y, -z);
        }
    }

    const index = [];
    for (let b = 0; b < gh - 1; b++) {
        for (let a = 0; a < gw - 1; a++) {
            const i00 = b * gw + a, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
            if (Math.max(sdfV[i00], sdfV[i10], sdfV[i01], sdfV[i11]) < -GRID_STEP) continue;
            index.push(i00, i01, i11, i00, i11, i10);                                   // front
            index.push(i00 + nV, i11 + nV, i01 + nV, i00 + nV, i10 + nV, i11 + nV);   // back
        }
    }

    const geometry = new TH.BufferGeometry();
    geometry.setAttribute('position', new TH.BufferAttribute(pos, 3));
    geometry.setAttribute('aUvFront', new TH.BufferAttribute(uvF, 2));
    geometry.setAttribute('aUvBack', new TH.BufferAttribute(uvB, 2));
    geometry.setAttribute('aShape', new TH.BufferAttribute(shape, 2));
    geometry.setAttribute('aSide', new TH.BufferAttribute(side, 1));
    geometry.setAttribute('aRim', new TH.BufferAttribute(rim, 1));
    geometry.setIndex(new TH.BufferAttribute(new Uint32Array(index), 1));
    geometry.computeVertexNormals();

    // Side color = most common color of both pictures
    const [sr, sg, sb] = dominantColor([A, B]);
    const sideColor = new TH.Color();
    if (TH.SRGBColorSpace) sideColor.setRGB(sr / 255, sg / 255, sb / 255, TH.SRGBColorSpace);
    else sideColor.setRGB(sr / 255, sg / 255, sb / 255);

    const texFront = imageTexture(front.image);
    const texBack = imageTexture(back.image);

    // alphaTest + alphaToCoverage: the cut-out outline is anti-aliased (smooth, not jagged)
    const material = new TH.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.7,          // softer, more fabric-like highlights
        metalness: 0.0,
        alphaTest: 0.5,
        alphaToCoverage: true
    });
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uFront = { value: texFront };
        shader.uniforms.uBack = { value: texBack };
        shader.uniforms.uMask = { value: maskTex };
        shader.uniforms.uSideColor = { value: sideColor };

        shader.vertexShader = `
            attribute vec2 aUvFront;
            attribute vec2 aUvBack;
            attribute vec2 aShape;
            attribute float aSide;
            attribute float aRim;
            varying vec2 vUvF;
            varying vec2 vUvB;
            varying vec2 vShape;
            varying float vSide;
            varying float vRim;
        ` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vUvF = aUvFront;
            vUvB = aUvBack;
            vShape = aShape;
            vSide = aSide;
            vRim = aRim;`
        );

        shader.fragmentShader = `
            uniform sampler2D uFront;
            uniform sampler2D uBack;
            uniform sampler2D uMask;
            uniform vec3 uSideColor;
            varying vec2 vUvF;
            varying vec2 vUvB;
            varying vec2 vShape;
            varying float vSide;
            varying float vRim;
        ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            // cut away everything outside the silhouette edge
            float maskV = texture2D(uMask, vShape).r;
            vec4 texel = vSide > 0.0 ? texture2D(uFront, vUvF) : texture2D(uBack, vUvB);
            // the rim (left / right / top / bottom sides) gets the dominant color
            float sideAmt = 1.0 - smoothstep(0.03, 0.16, vRim);
            diffuseColor.rgb = mix(texel.rgb, uSideColor, sideAmt);
            diffuseColor.a = maskV;   // alpha test cuts away everything outside the silhouette edge
            `
        );
    };

    const mesh = new TH.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.userData.dispose = () => {
        geometry.dispose();
        material.dispose();
        texFront.dispose();
        texBack.dispose();
        maskTex.dispose();
    };

    // Subsample vertices (used to keep the model sitting on the floor while it rotates)
    const total = samples.length / 3;
    const stride = Math.max(1, Math.ceil(total / 3000));
    const picked = [];
    for (let i = 0; i < total; i += stride) picked.push(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);

    return {
        mesh,
        radius: TARGET_SIZE / 2,
        samples: Float32Array.from(picked),
        sideColor: [sr, sg, sb]
    };
}