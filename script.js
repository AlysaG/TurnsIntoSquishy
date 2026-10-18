import * as TH from './three.module.js'
import { createUploadPanel } from './UPLOAD.js'
import { buildPlush } from './model.js'

const sizes = { width: window.innerWidth, height: window.innerHeight }

const scene = new TH.Scene();
const renderer = new TH.WebGLRenderer({ antialias: true });
const camera = new TH.PerspectiveCamera(60, sizes.width / sizes.height, 0.1, 1000);

// ---------- Zoom (mouse wheel / trackpad pinch / two-finger pinch) ----------
const CAM_TARGET = new TH.Vector3(0, -2, 0);   // the point the camera always looks at
const camBase = new TH.Vector3();              // camera position at zoom 1
const ZOOM_MIN = 0.45;                         // closest (multiplies the camera distance)
const ZOOM_MAX = 1.6;                          // farthest
let zoomTarget = 1;                            // where the zoom wants to be
let zoomCur = 1;                               // smoothed zoom actually applied
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

function applyZoom() {
    // slide the camera along the line to the target; it keeps looking at the object
    camera.position.copy(CAM_TARGET).addScaledVector(camBase.clone().sub(CAM_TARGET), zoomCur);
    camera.lookAt(CAM_TARGET);
}

function fitCamera() {
    // keep the whole ball + some empty margin visible, even on narrow phone screens
    const aspect = sizes.width / sizes.height;
    const dist = Math.max(14, 7.5 / (Math.tan(TH.MathUtils.degToRad(30)) * aspect));
    camBase.set(0, 4 + (dist - 14) * 0.3, dist);
    applyZoom();
}
fitCamera();

renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
renderer.domElement.style.touchAction = 'none';
renderer.domElement.style.cursor = 'pointer'; // pointer hand = rotation area

window.addEventListener('resize', () => {
    sizes.width = window.innerWidth;
    sizes.height = window.innerHeight;
    camera.aspect = sizes.width / sizes.height;
    camera.updateProjectionMatrix();
    fitCamera();
    renderer.setSize(sizes.width, sizes.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ---------- Lights ----------
// Soft, warm studio setup: sky/ground bounce + key + fill + rim
const CREAM = 0xfff1d6;
scene.background = new TH.Color(CREAM);
scene.fog = new TH.Fog(CREAM, 30, 70);   // far floor edge melts into the background

// sky (cool-white) / ground (warm cream) bounce light: gentle shading everywhere
scene.add(new TH.HemisphereLight(0xffffff, 0xf3dcb4, 0.75));

// key light: main warm light from upper right-front
const dirLight = new TH.DirectionalLight(0xfff4e0, 1.1);
dirLight.position.set(6, 12, 8);
scene.add(dirLight);

// fill light: soft cool light from the left so shadows aren't harsh
const fillLight = new TH.DirectionalLight(0xdfeaff, 0.35);
fillLight.position.set(-8, 5, 6);
scene.add(fillLight);

// rim light: from behind, outlines the object's edges
const rimLight = new TH.DirectionalLight(0xffffff, 0.45);
rimLight.position.set(0, 6, -10);
scene.add(rimLight);

// ---------- Floor ----------
const plane = new TH.Mesh(
    new TH.PlaneGeometry(120, 120),
    new TH.MeshStandardMaterial({ color: CREAM, roughness: 1, metalness: 0, side: TH.DoubleSide })
);
plane.rotation.x = -Math.PI * 0.5;
plane.position.y = -5;
scene.add(plane);

// ---------- Squishy ball ----------
const BALL_RADIUS = 3;
const ballGeo = new TH.SphereGeometry(BALL_RADIUS, 96, 64);
// Plain red ball with a few small marks, so you can see it turn
function makeBallTexture() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    // [x in 0..1 around the ball, y in 0..1 top to bottom, radius in px]
    [[0.10, 0.50, 20], [0.40, 0.42, 11], [0.47, 0.58, 8], [0.78, 0.50, 14]].forEach(([u, v, r]) => {
        g.beginPath();
        g.arc(u * c.width, v * c.height, r, 0, Math.PI * 2);
        g.fill();
    });
    const tex = new TH.CanvasTexture(c);
    if (TH.SRGBColorSpace) tex.colorSpace = TH.SRGBColorSpace;
    else if (TH.sRGBEncoding) tex.encoding = TH.sRGBEncoding;
    return tex;
}

const matBall = new TH.MeshStandardMaterial({
    map: makeBallTexture(),
    color: 0xffffff,
    roughness: 0.35,
    metalness: 0.0
});

// Squeeze strength (fingers are big and imprecise, so it is gentler than a mouse would need)
const PULL_SCALE = 0.7;      // 1 = surface follows the finger fully, lower = softer pull / push
const MAX_PULL = 0.95;       // longest stretch / dent, as a fraction of the object's radius
const SQUASH_DEPTH = 0.4;    // double-tap + hold: how much the whole object flattens (0.55 was the old value)

const squishUniforms = {
    uGrab:   { value: new TH.Vector3() },   // grab point (ball local space)
    uOffset: { value: new TH.Vector3() },   // how far the grab point is moved
    uRadius: { value: BALL_RADIUS * 0.8 },  // how wide the squeezed area is
    uSquash: { value: 0 },                  // whole-ball squash (double-tap + hold)
    uAxis:   { value: new TH.Vector3(0, 1, 0) } // squash axis in ball local space (world up)
};

// Squish shader: works on any mesh (ball or plush model), see installSquish()
function installSquish(shader) {
    shader.uniforms.uGrab = squishUniforms.uGrab;
    shader.uniforms.uOffset = squishUniforms.uOffset;
    shader.uniforms.uRadius = squishUniforms.uRadius;
    shader.uniforms.uSquash = squishUniforms.uSquash;
    shader.uniforms.uAxis = squishUniforms.uAxis;

    shader.vertexShader = `
        uniform vec3 uGrab;
        uniform vec3 uOffset;
        uniform float uRadius;
        uniform float uSquash;
        uniform vec3 uAxis;

        vec3 squishLocal(vec3 p) {
            float d = distance(p, uGrab);
            float w = exp(-(d * d) / (uRadius * uRadius));          // local pull/push
            float w2 = exp(-(d * d) / (4.0 * uRadius * uRadius));   // wide bulge
            vec3 q = p + uOffset * w;

            float len = length(uOffset);
            if (len > 1e-5) {
                vec3 dir = uOffset / len;
                vec3 n = normalize(p);
                vec3 side = n - dir * dot(n, dir);
                // pushing in -> sides bulge out, pulling out -> sides thin
                float push = -dot(uOffset, normalize(uGrab));
                q += side * push * 0.3 * w2;
            }
            return q;
        }

        // Whole-ball squash along uAxis, volume preserving (negative = stretch)
        vec3 squish(vec3 p0) {
            float k = 1.0 - ${SQUASH_DEPTH.toFixed(3)} * uSquash;
            float a = dot(p0, uAxis);
            vec3 perp = p0 - uAxis * a;
            vec3 squashed = perp * inversesqrt(k) + uAxis * (a * k);
            return squishLocal(p0) + (squashed - p0);
        }
    ` + shader.vertexShader;

    // Recompute the normal so lighting follows the deformed surface
    shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {
            vec3 n0 = normalize(normal);
            vec3 t1 = normalize(cross(n0, abs(n0.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 t2 = cross(n0, t1);
            float eps = 0.02;
            vec3 p0 = squish(position);
            vec3 p1 = squish(position + t1 * eps);
            vec3 p2 = squish(position + t2 * eps);
            objectNormal = normalize(cross(p1 - p0, p2 - p0));
        }
        `
    );

    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `vec3 transformed = squish(position);`
    );
}
matBall.onBeforeCompile = installSquish;

// The object you squeeze and rotate (starts as the ball, becomes your picture model)
let ball = new TH.Mesh(ballGeo, matBall);
const startBall = ball;           // kept so the refresh button can bring it back
let objectRadius = BALL_RADIUS;   // rough size of the object
let lowestSamples = null;         // model vertices used to keep it on the floor (null = ball)
ball.position.y = -5 + BALL_RADIUS; // rests on the floor
scene.add(ball);

// ---------- 360 ring indicator (thin blue ring with two arrows around the ball) ----------
const RING_RADIUS = 5;
const ringMat = new TH.MeshBasicMaterial({ color: 0x1e6fff, transparent: true, opacity: 0.3 });
const ring = new TH.Group();
ring.position.y = -5 + BALL_RADIUS; // ball's resting center height
const torus = new TH.Mesh(new TH.TorusGeometry(RING_RADIUS, 0.06, 8, 96), ringMat);
torus.rotation.x = Math.PI / 2;     // lay it flat around the ball
ring.add(torus);
[0, Math.PI].forEach((phi) => {
    const arrow = new TH.Mesh(new TH.ConeGeometry(0.28, 0.8, 16), ringMat);
    arrow.position.set(Math.cos(phi) * RING_RADIUS, 0, Math.sin(phi) * RING_RADIUS);
    arrow.quaternion.setFromUnitVectors(
        new TH.Vector3(0, 1, 0),
        new TH.Vector3(-Math.sin(phi), 0, Math.cos(phi)) // point along the ring
    );
    ring.add(arrow);
});
const SHOW_RING = false;            // set to true to show the blue 360 ring again
ring.visible = SHOW_RING;
scene.add(ring);
let ringTarget = 0.3;               // faint hint normally, bright when in the rotation area

// ---------- Swap the object (ball -> model made from pictures) ----------
const floorMatrix = new TH.Matrix4();

// Height of the object's center so its lowest point touches the floor (y = -5)
function restY(k) {
    if (!lowestSamples) return -5 + objectRadius * k;   // ball
    floorMatrix.makeRotationFromQuaternion(ball.quaternion);
    const e = floorMatrix.elements;
    let minY = Infinity;
    for (let i = 0; i < lowestSamples.length; i += 3) {
        const y = e[1] * lowestSamples[i] + e[5] * lowestSamples[i + 1] + e[9] * lowestSamples[i + 2];
        if (y < minY) minY = y;
    }
    return -5 - minY * k;
}

function setActiveObject(mesh, radius, samples) {
    scene.remove(ball);
    if (ball.userData.dispose) ball.userData.dispose();
    ball = mesh;
    objectRadius = radius;
    lowestSamples = samples;
    squishUniforms.uRadius.value = radius * 0.8;
    ball.quaternion.identity();
    // start still
    squishUniforms.uOffset.value.set(0, 0, 0);
    squishUniforms.uSquash.value = 0;
    targetOffset.set(0, 0, 0);
    velocity.set(0, 0, 0);
    sq = 0; sqVel = 0;
    velX = velY = 0;
    pendDX = pendDY = 0;
    ball.position.y = restY(1);
    scene.add(ball);
}

// ---------- Mouse interaction ----------
const raycaster = new TH.Raycaster();
const pointer = new TH.Vector2();
const dragPlane = new TH.Plane();
const grabWorld = new TH.Vector3();
const hitOnPlane = new TH.Vector3();

let dragging = false;
let rotating = false;
let squeezing = false;          // double-tap + hold active
let secondTap = false;
let movedFar = false;
let holdTimer = null;
let lastTapTime = 0;
let downTime = 0, downX = 0, downY = 0;
const DOUBLE_TAP_MS = 300;      // max gap between the two taps
const HOLD_MS = 500;            // hold the second tap this long to squeeze
const TAP_MAX_MS = 250;         // a press shorter than this counts as a tap
let sq = 0, sqVel = 0;          // squash amount + spring velocity
let lastX = 0, lastY = 0;
const ROTATE_SPEED = Math.PI * 1.5; // radians turned by a drag across the shorter screen side (same feel on phone and desktop)
const SMOOTHING = 35;       // higher = follows your finger tighter, lower = silkier but laggier
const INERTIA_DECAY = 3;    // how fast the glide after letting go fades (higher = stops sooner, 100 = no glide)
const MAX_FLICK = 4000;     // px/s cap so a wild flick can't spin it crazy fast
let lastMoveTime = 0;
let pendDX = 0, pendDY = 0; // drag distance waiting to be applied (smoothed in the render loop)
let velX = 0, velY = 0;     // glide speed in px/s
const ALLOW_TUMBLE = true;  // true = rotate from any angle (left/right + up/down), false = turntable spin only
const tmpQ = new TH.Quaternion();
const tmpAxis = new TH.Vector3();
const targetOffset = new TH.Vector3();  // where the finger wants the surface
const velocity = new TH.Vector3();      // spring velocity

// Trackball rotation: drag left/right to spin, up/down to tumble; any direction, no limits (full 360 on every axis)
const camRight = new TH.Vector3();
function rotateBy(dx, dy) {
    const k = ROTATE_SPEED / Math.min(sizes.width, sizes.height); // px -> radians
    ring.rotation.y += dx * k;   // the arrows ring spins along

    // ONE rotation around the axis perpendicular to the drag:
    // sideways drag = spin around world up, up/down drag = tumble around camera right.
    // (Two separate rotations in a row felt twisty on diagonal drags.)
    camera.updateMatrixWorld();
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    tmpAxis.set(0, dx, 0);
    if (ALLOW_TUMBLE) tmpAxis.addScaledVector(camRight, dy);
    const len = tmpAxis.length();
    if (len < 1e-6) return;
    tmpQ.setFromAxisAngle(tmpAxis.divideScalar(len), len * k);
    ball.quaternion.premultiply(tmpQ).normalize();   // normalize avoids drift after lots of turning
}

// Cursor feedback: pointer in the rotation area, open hand over the ball
function updateCursor(e) {
    if (dragging || rotating) return;
    setPointer(e);
    const overBall = raycaster.intersectObject(ball).length > 0;
    renderer.domElement.style.cursor = overBall ? 'grab' : 'pointer';
    ringTarget = overBall ? 0.3 : 0.95;
}

function setPointer(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
}

// ----- zoom input -----
const pointers = new Map();          // active fingers / mouse buttons
let pinching = false;
let pinchStartDist = 1, pinchStartZoom = 1;

function pinchDistance() {
    const [a, b] = [...pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
}

function startPinch() {
    // a second finger landed: drop whatever the first finger was doing
    clearTimeout(holdTimer);
    rotating = false;
    dragging = false;
    squeezing = false;
    targetOffset.set(0, 0, 0);
    velX = velY = 0;
    pendDX = pendDY = 0;
    pinching = true;
    pinchStartDist = pinchDistance();
    pinchStartZoom = zoomTarget;
}

renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    const speed = e.ctrlKey ? 0.01 : 0.0012;   // trackpad pinch arrives as ctrl + wheel
    zoomTarget = clampZoom(zoomTarget * Math.exp(e.deltaY * speed));
}, { passive: false });

renderer.domElement.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
        renderer.domElement.setPointerCapture(e.pointerId);
        startPinch();
        return;
    }
    if (pointers.size > 2) return;
    setPointer(e);
    const hit = raycaster.intersectObject(ball)[0];
    renderer.domElement.setPointerCapture(e.pointerId);

    if (!hit || e.shiftKey || e.button === 2) {
        // Touched empty space (or Shift / right-click on the object): rotate the ball
        renderer.domElement.style.cursor = 'pointer';
        rotating = true;
        lastX = e.clientX;
        lastY = e.clientY;
        lastMoveTime = performance.now();
        ringTarget = 0.95;
        velX = velY = 0;        // touching stops any glide
        pendDX = pendDY = 0;
        return;
    }

    renderer.domElement.style.cursor = 'grabbing'; // closed hand while squeezing
    ringTarget = 0.3;
    dragging = true;
    movedFar = false;
    downTime = performance.now();
    downX = e.clientX;
    downY = e.clientY;
    secondTap = (downTime - lastTapTime) < DOUBLE_TAP_MS;
    if (secondTap) {
        holdTimer = setTimeout(() => {
            if (dragging && !movedFar) {
                squeezing = true;
                targetOffset.set(0, 0, 0);
            }
        }, HOLD_MS);
    }

    grabWorld.copy(hit.point);
    squishUniforms.uGrab.value.copy(ball.worldToLocal(hit.point.clone()));
    squishUniforms.uOffset.value.set(0, 0, 0);
    velocity.set(0, 0, 0);

    // Drag on a plane through the grab point that faces the camera
    const camDir = new TH.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, grabWorld);
});

renderer.domElement.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinching) {
        // fingers spread apart -> zoom in, together -> zoom out
        zoomTarget = clampZoom(pinchStartZoom * pinchStartDist / pinchDistance());
        return;
    }
    if (!rotating && !dragging) { updateCursor(e); return; }
    if (rotating) {
        const now = performance.now();
        const mdx = e.clientX - lastX, mdy = e.clientY - lastY;
        const mdt = Math.max(8, now - lastMoveTime) / 1000;
        // flick speed measured from the raw finger movement (not the smoothed one)
        velX += (Math.max(-MAX_FLICK, Math.min(MAX_FLICK, mdx / mdt)) - velX) * 0.5;
        velY += (Math.max(-MAX_FLICK, Math.min(MAX_FLICK, mdy / mdt)) - velY) * 0.5;
        lastMoveTime = now;
        pendDX += mdx;   // applied smoothly in animate()
        pendDY += mdy;
        lastX = e.clientX;
        lastY = e.clientY;
        return;
    }
    if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > 15) movedFar = true;
    if (!dragging || squeezing) return;
    setPointer(e);
    if (raycaster.ray.intersectPlane(dragPlane, hitOnPlane)) {
        // world drag -> ball local space (ball may be rotated)
        targetOffset.copy(hitOnPlane).sub(grabWorld)
            .applyQuaternion(ball.quaternion.clone().invert())
            .multiplyScalar(PULL_SCALE);
        // Limit how far it can be stretched/squeezed
        const maxLen = objectRadius * MAX_PULL;
        if (targetOffset.length() > maxLen) targetOffset.setLength(maxLen);
    }
});

function release(e) {
    if (e) pointers.delete(e.pointerId);
    if (pinching) {
        if (pointers.size < 2) pinching = false;   // the leftover finger does nothing until lifted
        return;
    }
    if (rotating) {
        rotating = false;
        // finger stopped before lifting -> no glide (otherwise it spins on from old speed)
        if (performance.now() - lastMoveTime > 80) velX = velY = 0;
    } else if (dragging) {
        clearTimeout(holdTimer);
        const now = performance.now();
        const wasTap = !squeezing && !movedFar && (now - downTime) < TAP_MAX_MS;
        lastTapTime = (wasTap && !secondTap) ? now : 0;
        squeezing = false;      // let go -> jelly aftereffect
        dragging = false;
        targetOffset.set(0, 0, 0);
    } else {
        return;
    }
    if (e && renderer.domElement.hasPointerCapture(e.pointerId)) {
        renderer.domElement.releasePointerCapture(e.pointerId);
    }
    if (e) updateCursor(e);
}
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault()); // right-click = rotate
renderer.domElement.addEventListener('pointerup', release);
renderer.domElement.addEventListener('pointercancel', release);

// ---------- Render loop (ball only moves while you interact) ----------
const clock = new TH.Clock();
const STIFFNESS = 220;  // higher = firmer
const DAMPING = 9;      // lower = more jiggle

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 1 / 30);

    // Spring: offset chases targetOffset with a bit of wobble
    const offset = squishUniforms.uOffset.value;
    const force = targetOffset.clone().sub(offset).multiplyScalar(STIFFNESS)
        .addScaledVector(velocity, -DAMPING);
    velocity.addScaledVector(force, dt);
    offset.addScaledVector(velocity, dt);

    // Whole-ball squash spring: slow press while held, wobbly overshoot on release
    const sqTarget = squeezing ? 1 : 0;
    const sqK = squeezing ? 70 : 140;
    const sqD = squeezing ? 14 : 4.5;
    sqVel += ((sqTarget - sq) * sqK - sqVel * sqD) * dt;
    sq += sqVel * dt;
    if (!squeezing && Math.abs(sq) < 1e-3 && Math.abs(sqVel) < 1e-3) { sq = 0; sqVel = 0; }
    squishUniforms.uSquash.value = sq;
    squishUniforms.uAxis.value.set(0, 1, 0).applyQuaternion(ball.quaternion.clone().invert());
    ball.position.y = restY(1 - SQUASH_DEPTH * sq); // keep the bottom on the floor

    // Smooth rotation: ease toward where your finger is, then glide a little after release
    const f = 1 - Math.exp(-SMOOTHING * dt);
    const ax = pendDX * f, ay = pendDY * f;
    pendDX -= ax;
    pendDY -= ay;
    if (!rotating) {
        // friction is a bit stronger at low speed, so the glide fades out softly instead of stopping dead
        const speed = Math.hypot(velX, velY);
        const decay = Math.exp(-(INERTIA_DECAY + 400 / (speed + 100)) * dt);
        velX *= decay;
        velY *= decay;
        if (Math.abs(velX) < 1 && Math.abs(velY) < 1) velX = velY = 0;
        if (Math.abs(pendDX) < 0.01 && Math.abs(pendDY) < 0.01) pendDX = pendDY = 0;
    }
    const mx = ax + (rotating ? 0 : velX * dt);
    const my = ay + (rotating ? 0 : velY * dt);
    if (mx || my) rotateBy(mx, my);

    ringMat.opacity += (ringTarget - ringMat.opacity) * 0.15;

    // Snap to perfectly still once settled
    if (!dragging && offset.lengthSq() < 1e-6 && velocity.lengthSq() < 1e-6) {
        offset.set(0, 0, 0);
        velocity.set(0, 0, 0);
    }

    // Smooth zoom: the camera glides toward the zoom you asked for
    if (Math.abs(zoomTarget - zoomCur) > 1e-4) {
        zoomCur += (zoomTarget - zoomCur) * (1 - Math.exp(-12 * dt));
        applyZoom();
    }

    renderer.render(scene, camera);
}

animate();

// ---------- Upload panel: front + back pictures -> 3D model ----------
const uploader = createUploadPanel({
    onReset: () => setActiveObject(startBall, BALL_RADIUS, null),   // refresh button -> back to the ball
    onSubmit: async ({ front, back }) => {
        uploader.setBusy(true);
        await new Promise((r) => setTimeout(r, 30));   // let the "Building" label show up
        try {
            const plush = buildPlush(front, back);
            const compile = plush.mesh.material.onBeforeCompile;
            plush.mesh.material.onBeforeCompile = (shader) => {
                installSquish(shader);   // same squish + rotate as the ball
                compile(shader);
            };
            setActiveObject(plush.mesh, plush.radius, plush.samples);
        } catch (err) {
            console.error(err);
            uploader.showError('Could not build the 3D model. Try a clearer picture.');
        }
        uploader.setBusy(false);
    }
});
