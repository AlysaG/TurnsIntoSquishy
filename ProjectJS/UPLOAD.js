// Upload panel: pick a FRONT and a BACK picture (PNG or JPEG).
// Usage: createUploadPanel({ onSubmit: ({ front, back }) => { ... } })
// front / back = { file, url, image }  (image is a loaded HTMLImageElement)

const ACCEPT = ['image/png', 'image/jpeg'];
const MAX_MB = 10;

export function createUploadPanel({ onSubmit, onReset } = {}) {
    const state = { front: null, back: null };

    // ---------- panel ----------
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed',
        top: 'calc(12px + env(safe-area-inset-top, 0px))',
        left: 'calc(12px + env(safe-area-inset-left, 0px))',
        width: 'min(236px, calc(100vw - 24px))',
        padding: '12px',
        boxSizing: 'border-box',
        background: 'rgba(255,255,255,0.95)',
        borderRadius: '14px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        font: '13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#222',
        zIndex: '10',
        userSelect: 'none'
    });

    // header with collapse button
    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '10px'
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
        width: '34px',
        height: '34px',
        cursor: 'pointer',
        fontSize: '18px',
        lineHeight: '1'
    });
    header.append(title, collapse);

    const body = document.createElement('div');

    // two slots
    const slots = document.createElement('div');
    Object.assign(slots.style, { display: 'flex', gap: '10px' });

    const error = document.createElement('div');
    Object.assign(error.style, { color: '#c62828', minHeight: '18px', margin: '8px 0 2px' });

    const hint = document.createElement('div');
    hint.textContent = 'PNG or JPEG. Clear line art works best.';
    Object.assign(hint.style, { color: '#666', fontSize: '12px', marginTop: '8px' });

    const next = document.createElement('button');
    next.textContent = 'Continue';
    next.disabled = true;
    Object.assign(next.style, {
        width: '100%',
        padding: '9px',
        border: 'none',
        borderRadius: '8px',
        fontWeight: '600',
        fontSize: '14px'
    });

    // Refresh button: clears the pictures and brings the ball back
    const refresh = document.createElement('button');
    refresh.innerHTML = '<span style="font-size:16px;margin-right:6px">↻</span>Delete';
    Object.assign(refresh.style, {
        width: '100%',
        marginTop: '8px',
        padding: '9px',
        border: '1.5px solid #1e6fff',
        borderRadius: '8px',
        background: '#fff',
        color: '#1e6fff',
        fontWeight: '600',
        fontSize: '14px',
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
        Object.assign(wrap.style, { flex: '1', textAlign: 'center' });

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
        plus.innerHTML = '<div style="font-size:26px;line-height:1">+</div><div style="font-size:11px">Add</div>';
        box.appendChild(plus);

        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.title = 'Remove';
        Object.assign(remove.style, {
            position: 'absolute',
            top: '4px',
            right: '4px',
            width: '30px',
            height: '30px',
            border: 'none',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'none',
            fontSize: '14px'
        });
        box.appendChild(remove);

        const caption = document.createElement('div');
        caption.textContent = label;
        Object.assign(caption.style, { marginTop: '5px', fontWeight: '600' });

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

    function setCollapsed(c) {
        body.style.display = c ? 'none' : 'block';
        collapse.textContent = c ? '+' : '–';
        collapse.title = c ? 'Expand' : 'Collapse';
    }
    collapse.addEventListener('click', () => {
        setCollapsed(body.style.display !== 'none');
    });

    body.append(slots, error, next, refresh, hint);
    panel.append(header, body);
    document.body.appendChild(panel);
    refreshNext();

    function setBusy(busy) {
        refreshNext();
        if (busy) {
            next.disabled = true;
            next.textContent = 'Building 3D…';
            next.style.cursor = 'wait';
            showError('');
        } else {
            next.textContent = 'Finish';
            // on phones, tuck the panel away once the model is ready so it doesn't cover it
            // (stays open if there was an error, so you can read the message)
            if (!error.textContent && window.matchMedia('(max-width: 700px), (pointer: coarse)').matches) {
                setCollapsed(true);
            }
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