import { Configuration, NopeCHAApi } from 'nopecha';
import "dotenv/config";

// Official NopeCHA client config (no hardcoded fallback keys)
// Use environment variable for API key security (no hardcoded fallback)
const configuration = new Configuration({
    apiKey: process.env.NOPECHA_KEY
});
const nopecha = new NopeCHAApi(configuration);

// --- Utility helpers ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function findFrameBy(page, predicate, { timeout = 10000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const frame = page.frames().find(predicate);
        if (frame) return frame;
        await sleep(200);
    }
    return null;
}

async function clickRecaptchaCheckboxIfPresent(page) {
    // The checkbox lives in the anchor iframe; try common selectors
        const anchorPredicate = (f) => /\/anchor\?/i.test(f.url() || '');

    const anchorFrame = await findFrameBy(page, anchorPredicate, { timeout: 5000 });
    if (!anchorFrame) return false;

    try {
        console.log('Attempting to click reCAPTCHA checkbox in anchor frame...');
        await anchorFrame.waitForSelector('.recaptcha-checkbox-border', { timeout: 5000 });
        // Run the provided snippet inside the frame
        await anchorFrame.evaluate(() => {
            const el = document.getElementsByClassName('recaptcha-checkbox-border')[0];
            if (el) el.click();
        });
        return true;
    } catch (e) {
        console.warn('Checkbox not found or click failed:', e.message);
        return false;
    }
}

async function getChallengeFrame(page) {
    // The challenge uses "bframe" URL and a title similar to "recaptcha challenge expires in two minutes"
        const pred = (f) => /\/bframe/i.test(f.url() || '');
    return await findFrameBy(page, pred, { timeout: 10000 });
}

function isFrameDetachedError(err) {
    const msg = (err && err.message) || String(err || '');
    return /frame\s+was\s+detached/i.test(msg) || /detached\s+from\s+document/i.test(msg);
}

async function retryWithChallengeFrame(page, fn, { attempts = 3, delay = 250 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const frame = await getChallengeFrame(page);
        if (!frame) {
            lastErr = new Error('Challenge frame not found');
            await sleep(delay);
            continue;
        }
        try {
            return await fn(frame);
        } catch (e) {
            if (isFrameDetachedError(e)) {
                lastErr = e;
                await sleep(delay);
                continue;
            }
            throw e;
        }
    }
    throw lastErr || new Error('Failed to execute in challenge frame');
}

async function extractNopechaPayloadFromChallenge(page) {
    // Extract { type, task, image_urls, grid } from the challenge DOM
    return await retryWithChallengeFrame(page, (frame) => frame.evaluate(() => {
        function getText(selectors) {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && (el.textContent || '').trim()) return el.textContent.trim();
            }
            return '';
        }

        function getBackgroundUrl(el) {
            const bi = getComputedStyle(el).backgroundImage;
            const m = bi && bi.match(/url\(["']?(.*?)["']?\)/);
            return m ? m[1] : null;
        }

        // Try to locate instruction text; combine base + <strong> if available
        const baseInstruction = getText([
            '.rc-imageselect-desc-no-canonical',
            '.rc-imageselect-desc',
            '.rc-imageselect-instructions div',
            '#rc-imageselect div[class*="instructions"]',
        ]);
        const strongTarget = getText([
            '.rc-imageselect-instructions strong',
        ]);
        let task = baseInstruction || 'Please select all matching images.';
        if (strongTarget) {
            // If target not included already, append it
            if (!new RegExp(strongTarget.replace(/[-/\\^$*+?.()|[\]{}]/g, '.'), 'i').test(task)) {
                task = `${task} ${strongTarget}`.trim();
            }
        }

        // Collect tile elements and derive image URLs (supports sprite/background-based tiles)
    const imgNodes = Array.from(document.querySelectorAll('.rc-image-tile-wrapper img, .rc-imageselect-target img'));
    const tileBGNodes = Array.from(document.querySelectorAll('.rc-image-tile-wrapper .rc-image-tile, .rc-image-tile'));
    const containerBGNodes = Array.from(document.querySelectorAll('.rc-imageselect-target, .rc-imageselect-dynamic, .rc-imageselect-challenge'));

    const urlsFromImgs = imgNodes.map((img) => img.src).filter(Boolean);
    const urlsFromTileBGs = tileBGNodes.map((el) => getBackgroundUrl(el)).filter(Boolean);
    const urlsFromContainers = containerBGNodes.map((el) => getBackgroundUrl(el)).filter(Boolean);
    const containerUrl = urlsFromContainers.find(Boolean) || null;
    const combined = [...urlsFromImgs, ...urlsFromTileBGs, ...urlsFromContainers].filter(Boolean);

        // Deduplicate while preserving order
        const seen = new Set();
    const deduped = combined.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

        // Determine grid size robustly, clamped to common recaptcha grids (3x3 or 4x4)
        let grid = '';
        let _rows = 0;
        let _cols = 0;
        let _gridSource = '';

        // Prefer table structure when available
        const table = document.querySelector('.rc-imageselect-table');
        if (table) {
            const rowsEls = Array.from(table.querySelectorAll('tr'));
            const r = rowsEls.length;
            const c = rowsEls.length ? Math.max(...rowsEls.map((tr) => tr.querySelectorAll('td').length)) : 0;
            if (r && c) {
                // Clamp to 3 or 4 when possible
                const rr = r >= 4 ? 4 : 3;
                const cc = c >= 4 ? 4 : 3;
                _rows = rr; _cols = cc; grid = `${rr}x${cc}`; _gridSource = 'table';
            }
        }

        // Next, try class signature (rc-image-tile-33/44)
        if (!grid) {
            const sigEl = document.querySelector('.rc-image-tile, .rc-image-tile-wrapper, .rc-imageselect-grid');
            if (sigEl && sigEl.className) {
                const m = String(sigEl.className).match(/rc-image-tile-(\d)(\d)/);
                if (m) {
                    const rr = parseInt(m[1], 10);
                    const cc = parseInt(m[2], 10);
                    // Clamp unexpected values to 3 or 4
                    _rows = rr >= 4 ? 4 : 3;
                    _cols = cc >= 4 ? 4 : 3;
                    grid = `${_rows}x${_cols}`; _gridSource = 'class';
                }
            }
        }

        // Finally, infer from a single selector set to avoid double counting
        if (!grid) {
            const candidatesSelectors = [
                '.rc-image-tile-wrapper',
                '.rc-imageselect-tile',
                '.rc-image-tile',
            ];
            let tiles = [];
            for (const sel of candidatesSelectors) {
                tiles = Array.from(document.querySelectorAll(sel));
                if (tiles.length) break;
            }
            const n = tiles.length;
            if (n) {
                // Typical grids: 9 -> 3x3, 16 -> 4x4
                const dim = n <= 12 ? 3 : 4;
                _rows = dim; _cols = dim; grid = `${dim}x${dim}`; _gridSource = 'count';
            }
        }

        // Prefer composite container URL when available; else fall back to first deduped URL
        const finalImageUrls = containerUrl ? [containerUrl] : (deduped.length ? [deduped[0]] : []);

            return {
            type: 'recaptcha',
            task,
            image_urls: finalImageUrls,
            grid,
            _tileCount: (() => {
                const sel = ['.rc-image-tile-wrapper', '.rc-imageselect-tile', '.rc-image-tile'];
                for (const s of sel) {
                    const n = document.querySelectorAll(s).length;
                    if (n) return n;
                }
                return 0;
            })(),
            _rows,
            _cols,
            _gridSource,
        };
        }));
}

    async function waitForChallengeReady(page, { timeout = 8000, settle = 300 } = {}) {
    const start = Date.now();
    let lastCount = -1;
    while (Date.now() - start < timeout) {
            try {
                const ready = await retryWithChallengeFrame(page, (frame) => frame.evaluate(() => {
                const tiles = document.querySelectorAll('.rc-image-tile-wrapper, .rc-imageselect-tile, .rc-image-tile');
                const imgs = Array.from(document.querySelectorAll('.rc-image-tile-wrapper img, .rc-imageselect-target img'));
                const imgsReady = imgs.length ? imgs.every((img) => img.complete && img.naturalWidth > 0) : false;
                const bgEls = Array.from(document.querySelectorAll('.rc-image-tile, .rc-imageselect-target, .rc-imageselect-challenge, .rc-image-tile-wrapper'));
                const bgReady = bgEls.some((el) => {
                    const bi = getComputedStyle(el).backgroundImage;
                    return !!(bi && /url\(/.test(bi));
                });
                return { tileCount: tiles.length || imgs.length, imgsReady, bgReady };
                }));
            if (ready.tileCount > 0 && (ready.imgsReady || ready.bgReady)) {
                if (ready.tileCount === lastCount) {
                    await sleep(settle);
                    return true;
                }
                lastCount = ready.tileCount;
            }
        } catch (_) {
            // ignore transient errors during load
        }
        await sleep(200);
    }
    return false;
}

    async function clickTilesFromIndices(page, indices, gridInfo = {}) {
    // Click the specified tile indices and log clicked spots (no Verify here)
    try {
            const result = await retryWithChallengeFrame(page, (frame) => frame.evaluate((idxs) => {
            // Try multiple selectors for maximum compatibility
            const selectorSets = [
                '.rc-image-tile-wrapper',
                '.rc-image-tile-target',
                '.rc-imageselect-tile',
                '.rc-image-tile',
            ];
            let tiles = [];
            for (const sel of selectorSets) {
                tiles = Array.from(document.querySelectorAll(sel));
                if (tiles.length) break;
            }
            const rects = tiles.map((el) => el.getBoundingClientRect());
            const clicked = [];
            idxs.forEach((i) => {
                const t = tiles[i];
                const r = rects[i];
                if (t && r) {
                    // Click and record the center position
                    const cx = Math.round(r.left + r.width / 2);
                    const cy = Math.round(r.top + r.height / 2);
                    t.click();
                    clicked.push({ index: i, center: { x: cx, y: cy }, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
                }
            });
            return { clicked, tileCount: tiles.length };
            }, indices));

        const rows = gridInfo.rows || gridInfo._rows || 0;
        const cols = gridInfo.cols || gridInfo._cols || 0;
        for (const c of result.clicked) {
            const row = rows && cols ? Math.floor(c.index / cols) + 1 : undefined;
            const col = rows && cols ? (c.index % cols) + 1 : undefined;
            console.log(
                `Clicked tile index=${c.index}` +
                (row && col ? ` (row=${row}, col=${col})` : '') +
                ` at center x=${c.center.x}, y=${c.center.y}`
            );
        }
        return result;
    } catch (e) {
        console.warn('Clicking tiles failed:', e.message);
        return { clicked: [], tileCount: 0 };
    }
}

    async function clickGridCellsByContainer(page, indices, rows, cols) {
    try {
            const containerSelectors = [
                '.rc-imageselect-target',
                '.rc-image-tile-target',
                '.rc-imageselect-challenge',
                '.rc-imageselect-table',
            ];
            let handle = null;
            for (const sel of containerSelectors) {
                handle = await retryWithChallengeFrame(page, (frame) => frame.$(sel));
                if (handle) { break; }
            }
        if (!handle) {
            console.warn('No suitable container found for grid-based clicks.');
            return false;
        }

        const box = await handle.boundingBox();
        if (!box) {
            console.warn('Container not visible; cannot compute bounding box.');
            return false;
        }

        const cellW = box.width / cols;
        const cellH = box.height / rows;
        for (const idx of indices) {
            const r = Math.floor(idx / cols);
            const c = idx % cols;
            const offX = (c + 0.5) * cellW;
            const offY = (r + 0.5) * cellH;
            await handle.click({ position: { x: offX, y: offY } });
            const absX = Math.round(box.x + offX);
            const absY = Math.round(box.y + offY);
            console.log(`Grid-click idx=${idx} (row=${r + 1}, col=${c + 1}) at abs x=${absX}, y=${absY}`);
        }
        return true;
    } catch (e) {
        console.warn('Grid-based click failed:', e.message);
        return false;
    }
}

    async function getInstructionText(page) {
    try {
            return await retryWithChallengeFrame(page, (frame) => frame.evaluate(() => {
            const sels = [
                '.rc-imageselect-desc-no-canonical',
                '.rc-imageselect-desc',
                '.rc-imageselect-instructions',
                '#rc-imageselect div[class*="instructions"]',
            ];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.textContent) return el.textContent.trim();
            }
            return '';
            }));
    } catch {
        return '';
    }
}

    async function clickVerifyAfterDelay(page, { min = 2000, max = 3000 } = {}) {
    const delay = Math.floor(min + Math.random() * (max - min));
    await sleep(delay);
    try {
        const verifySel = '#recaptcha-verify-button, .button.verify, button[id*="verify"]';
            await retryWithChallengeFrame(page, (frame) => frame.waitForSelector(verifySel, { timeout: 2000 }));
            await retryWithChallengeFrame(page, (frame) => frame.click(verifySel));
        console.log('Clicked Verify after delay', delay, 'ms');
        return true;
    } catch (_) {
        console.log('Verify button not found after delay; continuing...');
        return false;
    }
}

async function solveImageChallengeIfPresent(page) {
        const frameExists = await getChallengeFrame(page);
        if (!frameExists) return false;

    console.log('reCAPTCHA image challenge detected. Extracting payload...');
    // Wait briefly to ensure all tiles/images are loaded before extraction
        try {
            await retryWithChallengeFrame(page, (frame) => frame.waitForSelector('.rc-imageselect-target, .rc-image-tile-wrapper, .rc-image-tile, .rc-imageselect-table', { timeout: 8000 }));
        } catch (_) {}
    console.log('Waiting for challenge images to load...');
        await waitForChallengeReady(page, { timeout: 8000, settle: 300 });

    // Repeat solving within the same challenge until instruction disappears or anchor is solved
    const maxInnerAttempts = 5;
    for (let attempt = 1; attempt <= maxInnerAttempts; attempt++) {
        const payload = await extractNopechaPayloadFromChallenge(page);
        const { type, task, image_urls, grid, _tileCount } = payload;
        console.log('Payload:', { type, task, grid, tiles: _tileCount, images: image_urls.length });

        if (!configuration.apiKey) {
            throw new Error('NOPECHA_KEY (or NOPECHA_API_KEY) is not set. Export it in your environment before running.');
        }

        // Log the exact image URLs and grid details being sent in the payload
        console.log('Calling NopeCHA Recognition API with:');
        console.log('  task:', task);
        console.log('  grid:', grid, '(source:', payload._gridSource || 'n/a', ', rows:', payload._rows, ', cols:', payload._cols, ')');
        console.log('  image_urls count:', image_urls.length);
        image_urls.forEach((u, i) => console.log(`  image_urls[${i}]: ${u}`));

        // Try SDK recognition first; fallback to REST recognize endpoint if needed
        let result;
        if (typeof nopecha.solveRecognition === 'function') {
            result = await nopecha.solveRecognition({ type, task, image_urls, grid });
        } else if (typeof fetch === 'function') {
            const res = await fetch('https://api.nopecha.com/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: NOPECHA_KEY, type, task, image_urls, grid })
            });
            const text = await res.text().catch(() => '');
            if (!res.ok) throw new Error(`NopeCHA /recognize error ${res.status}: ${text.slice(0,200)}`);
            try { result = JSON.parse(text); } catch { result = text; }
        } else {
            throw new Error('NopeCHA recognition not available (SDK or fetch)');
        }
        console.log('NopeCHA response:', result);

        // Normalize NopeCHA responses to indices
        let indices = [];
        const rows = payload._rows || (grid && Number(grid.split('x')[0])) || 0;
        const cols = payload._cols || (grid && Number(grid.split('x')[1])) || 0;

        if (Array.isArray(result)) {
            if (typeof result[0] === 'number') {
                indices = result;
            } else if (typeof result[0] === 'boolean') {
                // Flat boolean array of length rows*cols
                if (rows && cols && result.length === rows * cols) {
                    indices = result.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
                    console.log('Derived indices from flat boolean matrix:', indices);
                } else if (rows && cols && Array.isArray(result[0])) {
                    // Nested array [[row],[row],...]
                    indices = [];
                    for (let r = 0; r < result.length; r++) {
                        const rowA = result[r];
                        if (!Array.isArray(rowA)) continue;
                        for (let c = 0; c < rowA.length; c++) {
                            if (rowA[c]) indices.push(r * cols + c);
                        }
                    }
                    console.log('Derived indices from nested boolean matrix:', indices);
                }
            } else if (result[0] && typeof result[0] === 'object' && 'x' in result[0] && 'y' in result[0]) {
                // TODO: handle point-based clicks if service returns them (not typical for reCAPTCHA grid)
                console.log('Received point-based clicks; current flow expects indices. Skipping for now.');
            }
        } else if (result && Array.isArray(result.clicks)) {
            indices = result.clicks;
        }

        if (!indices.length) {
            console.warn('No indices returned by NopeCHA. Proceeding to verify anyway.');
        } else {
            // First attempt element-based clicks; if no tiles found/clicked, fall back to grid-based coordinates
                    const clickRes = await clickTilesFromIndices(page, indices, { rows, cols });
            if (!clickRes || !clickRes.clicked || !clickRes.clicked.length) {
                console.log('Element-based click yielded no clicks; falling back to grid-based coordinates.');
                        await clickGridCellsByContainer(page, indices, rows, cols);
            }
        }

        // Wait 2-3 seconds then click Verify
    await clickVerifyAfterDelay(page, { min: 2000, max: 3000 });

        // Check if solved or instruction persists
        const solved = await isAnchorSolved(page);
        if (solved) return true;

    const txt = (await getInstructionText(page)) || '';
        if (/please\s+select\s+all\s+matching\s+images/i.test(txt)) {
            console.log(`Attempt ${attempt}: instruction persists; repeating recognition...`);
            // Small wait for potential tile refresh
            await waitForChallengeReady(page, { timeout: 6000, settle: 250 });
            continue;
        }

        // If instruction changed or frame disappeared, stop inner loop
        const stillThere = await getChallengeFrame(page);
        if (!stillThere) return true;
        // Otherwise give a short pause and re-check
        await sleep(500);
        if (await isAnchorSolved(page)) return true;
    }

    return true;
}

async function isAnchorSolved(page) {
    const anchorFrame = await findFrameBy(page, (f) => /\/anchor\?/i.test(f.url() || ''), { timeout: 1500 });
    if (!anchorFrame) return false;
    try {
        return await anchorFrame.evaluate(() => {
            const box = document.querySelector('.recaptcha-checkbox');
            if (!box) return false;
            const aria = box.getAttribute('aria-checked');
            const checkedClass = box.classList.contains('recaptcha-checkbox-checked');
            return aria === 'true' || checkedClass;
        });
    } catch {
        return false;
    }
}

async function solveRecaptchaUntilGone(page, { maxRounds = 8 } = {}) {
    for (let round = 1; round <= maxRounds; round++) {
        // If already solved, stop
        if (await isAnchorSolved(page)) {
            console.log('reCAPTCHA solved (anchor checked).');
            return true;
        }

        // Ensure checkbox clicked (in case challenge not open yet)
        await clickRecaptchaCheckboxIfPresent(page);

        // Try to solve the current image challenge (if any)
        const attempted = await solveImageChallengeIfPresent(page);
        if (!attempted) {
            // No challenge visible yet; wait a bit and recheck
            await sleep(1200);
        }

        // Wait for either the challenge to disappear or anchor to be checked
        let waited = 0;
        while (waited < 8000) {
            if (await isAnchorSolved(page)) return true;
            const stillThere = await getChallengeFrame(page);
            if (!stillThere) break;
            await sleep(500);
            waited += 500;
        }

        console.log(`Round ${round} completed. Challenge ${await getChallengeFrame(page) ? 'still present' : 'not present'}.`);
    }

    console.warn('Max rounds reached; captcha may still be present.');
    return await isAnchorSolved(page);
}

// Public API: solve reCAPTCHA if present using NopeCHA
export async function solveRecaptchaIfPresent(page, { maxRounds = 8 } = {}) {
    try {
        // Best-effort: ensure checkbox is clicked to trigger challenge
        await clickRecaptchaCheckboxIfPresent(page);
        return await solveRecaptchaUntilGone(page, { maxRounds });
    } catch (e) {
        console.warn('solveRecaptchaIfPresent error:', e?.message || e);
        return false;
    }
}

// Optionally export internals for testing/tuning
export const _internal = {
    clickRecaptchaCheckboxIfPresent,
    solveImageChallengeIfPresent,
    solveRecaptchaUntilGone,
};
