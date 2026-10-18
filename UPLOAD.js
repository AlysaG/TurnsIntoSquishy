// Upload panel: pick a FRONT and a BACK picture (PNG or JPEG).
// Usage: createUploadPanel({ onSubmit: ({ front, back }) => { ... } })
// front / back = { file, url, image }  (image is a loaded HTMLImageElement)
//
// Phones / small screens get a COMPACT panel: it starts as a small "Make your 3D object" pill in the
// top-left corner, opens into a slim bar (pictures on the left, buttons on the right) and tucks itself
// away again after the model is built, so the object is never covered.

const ACCEPT = ['image/png', 'image/jpeg'];
const MAX_MB = 10;

const COMPACT = typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 700px), (pointer: coarse)').matches;

export function createUploadPanel({ onSubmit, onReset } = {}) {
    const state = { front: null, back: null };

    // ---------- panel ----------
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed',
        top: `calc(${COMPACT ? 8 : 12}px + env(safe-area-inset-top, 0px))`,
        left: `calc(${COMPACT ? 8 : 12}px + env(safe-area-inset-left, 0px))`,
        width: COMPACT ? 'auto' : 'min(236px, calc(100vw - 24px))',
        maxWidth: 'calc(100vw - 16px)',
        padding: COMPACT ? '6px 8px' : '12px',
        boxSizing: 'border-box',
        background: COMPACT ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(6px)',
        webkitBackdropFilter: 'blur(6px)',
        borderRadius: COMPACT ? '12px' : '14px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        font: `${COMPACT ? 12 : 13}px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif`,
        color: '#222',
        zIndex: '10',
        userSelect: 'none',
        touchAction: 'manipulation'
    });

    // header with collapse button
    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        marginBottom: COMPACT ? '0' : '10px',
        cursor: COMPACT ? 'pointer' : 'default'
    });
    const title = document.createElement('strong');
    title.textContent = 'Make your 3D object';
    const collapse = document.createElement('button');
    collapse.textContent = '–';
    collapse.title = 'Collapse';
    Object.assign(collapse.style, {
        border: 'none',
        background: '#eee',
        borderRadius: '6px',
        width: COMPACT ? '30px' : '34px',
        height: COMPACT ? '30px' : '34px',
        cursor: 'pointer',
        fontSize: '18px',
        lineHeight: '1',
        flex: 'none'
    });
    header.append(title, collapse);

    const body = document.createElement('div');

    // two slots
    const slots = document.createElement('div');
    Object.assign(slots.style, { display: 'flex', gap: COMPACT ? '8px' : '10px', flex: 'none' });

    const error = document.createElement('div');
    Object.assign(error.style, {
        color: '#c62828',
        minHeight: COMPACT ? '0' : '18px',
        margin: COMPACT ? '4px 0 0' : '8px 0 2px'
    });

    const hint = document.createElement('div');
    hint.textContent = 'PNG or JPEG. Clear line art works best.';
    Object.assign(hint.style, { color: '#666', fontSize: '12px', marginTop: '8px' });

    const next = document.createElement('button');
    next.textContent = 'Continue';
    next.disabled = true;
    Object.assign(next.style, {
        width: '100%',
        padding: COMPACT ? '8px' : '9px',
        border: 'none',
        borderRadius: '8px',
        fontWeight: '600',
        fontSize: COMPACT ? '13px' : '14px'
    });

    // Refresh button: clears the pictures and brings the ball back
    const refresh = document.createElement('button');
    refresh.innerHTML = COMPACT
        ? '<span style="font-size:15px;margin-right:5px">↻</span>Back to ball'
        : '<span style="font-size:16px;margin-right:6px">↻</span>Refresh (back to ball)';
    Object.assign(refresh.style, {
        width: '100%',
        marginTop: COMPACT ? '6px' : '8px',
        padding: COMPACT ? '7px' : '9px',
        border: '1.5px solid #1e6fff',
        borderRadius: '8px',
        background: '#fff',
        color: '#1e6fff',
        fontWeight: '600',
        fontSize: COMPACT ? '13px' : '14px',
        cursor: 'pointer'
    });
    refresh.addEventListener('mouseenter', () => { refresh.style.background = '#e8f0ff'; });
    refresh.addEventListener('mouseleave', () => { refresh.style.background = '#fff'; });

    function refreshNext() {
        const ready = !!(state.front && state.back);
        next.disabled = !ready;
        next.style.background = ready ? '#1e6fff' : '#c9c9c9';
        next.style.color = '#fff';
        next.style.cursor = ready ? 'pointer' : 'not-allowed';
    }

    function showError(msg) {
        error.textContent = msg || '';
    }

    // ---------- one slot (front or back) ----------
    function makeSlot(key, label) {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, COMPACT
            ? { flex: 'none', width: '64px', textAlign: 'center' }
            : { flex: '1', textAlign: 'center' });

        const box = document.createElement('div');
        box.tabIndex = 0;
        box.setAttribute('role', 'button');
        box.setAttribute('aria-label', `Upload ${label} picture`);
        Object.assign(box.style, {
            position: 'relative',
            aspectRatio: '1 / 1',
            border: '2px dashed #9aa5b1',
            borderRadius: '10px',
            background: '#f6f8fa center / contain no-repeat',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#667',
            overflow: 'hidden'
        });

        const plus = document.createElement('div');
        plus.innerHTML = COMPACT
            ? '<div style="font-size:22px;line-height:1">+</div><div style="font-size:10px">Add</div>'
            : '<div style="font-size:26px;line-height:1">+</div><div style="font-size:11px">Add</div>';
        box.appendChild(plus);

        const removeSize = COMPACT ? '26px' : '30px';
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.title = 'Remove';
        Object.assign(remove.style, {
            position: 'absolute',
            top: '2px',
            right: '2px',
            width: removeSize,
            height: removeSize,
            border: 'none',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'none',
            fontSize: COMPACT ? '12px' : '14px'
        });
        box.appendChild(remove);

        const caption = document.createElement('div');
        caption.textContent = label;
        Object.assign(caption.style, {
            marginTop: COMPACT ? '2px' : '5px',
            fontWeight: '600',
            fontSize: COMPACT ? '11px' : 'inherit'
        });

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ACCEPT.join(',');
        input.style.display = 'none';

        wrap.append(box, caption, input);

        function clear() {
            if (state[key]) URL.revokeObjectURL(state[key].url);
            state[key] = null;
            box.style.backgroundImage = 'none';
            box.style.border = '2px dashed #9aa5b1';
            plus.style.display = 'block';
            remove.style.display = 'none';
            refreshNext();
        }

        function handleFile(file) {
            showError('');
            if (!file) return;
            if (!ACCEPT.includes(file.type)) {
                showError('Please use a PNG or JPEG file.');
                return;
            }
            if (file.size > MAX_MB * 1024 * 1024) {
                showError(`Picture is too big (max ${MAX_MB} MB).`);
                return;
            }
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                if (state[key]) URL.revokeObjectURL(state[key].url);
                state[key] = { file, url, image };
                box.style.backgroundImage = `url("${url}")`;
                box.style.border = '2px solid #1e6fff';
                plus.style.display = 'none';
                remove.style.display = 'block';
                refreshNext();
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                showError('Could not read that picture.');
            };
            image.src = url;
        }

        // click / keyboard
        box.addEventListener('click', (e) => {
            if (e.target === remove) return;
            input.click();
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                input.click();
            }
        });
        input.addEventListener('change', () => {
            handleFile(input.files[0]);
            input.value = ''; // allow choosing the same file again
        });
        remove.addEventListener('click', (e) => {
            e.stopPropagation();
            clear();
        });

        // drag & drop
        box.addEventListener('dragover', (e) => {
            e.preventDefault();
            box.style.background = '#e8f0ff';
        });
        box.addEventListener('dragleave', () => {
            box.style.background = '#f6f8fa center / contain no-repeat';
            if (state[key]) box.style.backgroundImage = `url("${state[key].url}")`;
        });
        box.addEventListener('drop', (e) => {
            e.preventDefault();
            box.style.background = '#f6f8fa center / contain no-repeat';
            if (state[key]) box.style.backgroundImage = `url("${state[key].url}")`;
            handleFile(e.dataTransfer.files[0]);
        });

        return { wrap, clear };
    }

    const frontSlot = makeSlot('front', 'Front');
    const backSlot = makeSlot('back', 'Back');
    slots.append(frontSlot.wrap, backSlot.wrap);

    next.addEventListener('click', () => {
        if (!state.front || !state.back) return;
        if (onSubmit) onSubmit({ front: state.front, back: state.back });
    });

    // ---------- open / close ----------
    function setCollapsed(c) {
        body.style.display = c ? 'none' : 'block';
        collapse.textContent = c ? '+' : '–';
        collapse.title = c ? 'Expand' : 'Collapse';
        if (COMPACT) {
            // closed = small pill, open = slim bar
            panel.style.width = c ? 'auto' : 'min(350px, calc(100vw - 16px))';
            header.style.marginBottom = c ? '0' : '6px';
        }
    }
    collapse.addEventListener('click', () => {
        setCollapsed(body.style.display !== 'none');
    });
    if (COMPACT) {
        // on phones the whole title bar is a big tap target
        header.addEventListener('click', (e) => {
            if (e.target === collapse) return;
            setCollapsed(body.style.display !== 'none');
        });
    }

    // ---------- layout ----------
    if (COMPACT) {
        // pictures on the left, buttons on the right
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'stretch' });
        const controls = document.createElement('div');
        Object.assign(controls.style, {
            flex: '1',
            minWidth: '0',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center'
        });
        controls.append(next, refresh);
        row.append(slots, controls);
        body.append(row, error);
    } else {
        body.append(slots, error, next, refresh, hint);
    }
    panel.append(header, body);
    document.body.appendChild(panel);
    refreshNext();
    if (COMPACT) setCollapsed(true);   // start as a small pill so nothing covers the object

    function setBusy(busy) {
        refreshNext();
        if (busy) {
            next.disabled = true;
            next.textContent = 'Building 3D…';
            next.style.cursor = 'wait';
            showError('');
        } else {
            next.textContent = 'Continue';
            // on phones, tuck the panel away once the model is ready so it doesn't cover it
            // (stays open if there was an error, so you can read the message)
            if (!error.textContent && COMPACT) setCollapsed(true);
        }
    }

    refresh.addEventListener('click', () => {
        api.reset();
        if (onReset) onReset();
    });

    const api = {
        setBusy,
        showError,
        getImages: () => ({ front: state.front, back: state.back }),
        reset: () => {
            frontSlot.clear();
            backSlot.clear();
            showError('');
        },
        element: panel
    };
    return api;
}
