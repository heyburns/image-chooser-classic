import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { send_message, send_cancel } from "./image_chooser_messaging.js";

const EVENT_NAME = "cg-image-chooser-classic-widget-channel";
const THUMBNAIL_RIGHT_CLICK_SETTING_ID = "ImageChooser.thumbnailRightClick";
const THUMBNAIL_RIGHT_CLICK_DEFAULT = "Browser Default";
const activeWidgets = new Map();
let currentActiveNode = null;
const FALLBACK_ASPECT = 1;
const MIN_CELL_EDGE = 1;
let middleDragActive = false;
let middleDragPointerId = null;
const alertAudio = new Audio("extensions/image-chooser-classic/ding.mp3");

function playAlertIfEnabled() {
    if (app?.ui?.settings?.getSettingValue("ImageChooser.alert", true)) {
        alertAudio.currentTime = 0;
        alertAudio.play().catch(() => {});
    }
}

function canElementScroll(el, deltaY, deltaX) {
    if (!(el instanceof HTMLElement)) return false;

    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;

    const canScrollY =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 1;
    const canScrollX =
        (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") &&
        el.scrollWidth > el.clientWidth + 1;

    if (canScrollY && deltaY !== 0) {
        if (deltaY < 0 && el.scrollTop > 0) return true;
        const maxY = el.scrollHeight - el.clientHeight;
        if (deltaY > 0 && el.scrollTop < maxY) return true;
    }

    if (canScrollX && deltaX !== 0) {
        if (deltaX < 0 && el.scrollLeft > 0) return true;
        const maxX = el.scrollWidth - el.clientWidth;
        if (deltaX > 0 && el.scrollLeft < maxX) return true;
    }

    return false;
}

function shouldUseLocalScroll(startEl, boundaryEl, deltaY, deltaX) {
    let node = startEl;
    while (node && node !== boundaryEl) {
        if (canElementScroll(node, deltaY, deltaX)) return true;
        node = node.parentElement;
    }
    return canElementScroll(boundaryEl, deltaY, deltaX);
}

function getComfyCanvas() {
    const canvas = app?.canvas ?? window?.app?.canvas;
    return canvas ?? null;
}

function getGraphCanvasElement() {
    const direct = app?.canvas?.canvas;
    if (direct instanceof HTMLCanvasElement) return direct;

    const nested = app?.canvas?.canvas?.canvas;
    if (nested instanceof HTMLCanvasElement) return nested;

    return document.querySelector("canvas") ?? null;
}

function forwardCanvasEvent(kind, event) {
    const canvas = getComfyCanvas();
    const methodMap = {
        wheel: "processMouseWheel",
        down: "processMouseDown",
        move: "processMouseMove",
        up: "processMouseUp",
    };
    const methodName = methodMap[kind];
    if (canvas && typeof canvas[methodName] === "function") {
        canvas[methodName](event);
        return;
    }

    // Fallback for unusual environments where app.canvas handlers are unavailable.
    const canvasEl = getGraphCanvasElement();
    if (!canvasEl) return;

    if (kind === "wheel") {
        const forwarded = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        });
        canvasEl.dispatchEvent(forwarded);
        return;
    }

    const typeMap = {
        down: "mousedown",
        move: "mousemove",
        up: "mouseup",
    };
    const forwardedType = typeMap[kind];
    const forwarded = new MouseEvent(forwardedType, {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
    });
    canvasEl.dispatchEvent(forwarded);
}

function handleWidgetWheel(event, container) {
    if (shouldUseLocalScroll(event.target, container, event.deltaY, event.deltaX)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    forwardCanvasEvent("wheel", event);
}

function stopMiddleDragForwarding() {
    if (!middleDragActive) return;
    middleDragActive = false;
    middleDragPointerId = null;
    window.removeEventListener("pointermove", handleWindowPointerMoveForPan, true);
    window.removeEventListener("pointerup", handleWindowPointerUpForPan, true);
    window.removeEventListener("pointercancel", handleWindowPointerUpForPan, true);
    window.removeEventListener("blur", stopMiddleDragForwarding, true);
}

function handleWindowPointerMoveForPan(event) {
    if (!middleDragActive) return;
    if (middleDragPointerId !== null && event.pointerId !== middleDragPointerId) return;
    if ((event.buttons & 4) !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    forwardCanvasEvent("move", event);
}

function handleWindowPointerUpForPan(event) {
    if (!middleDragActive) return;
    if (middleDragPointerId !== null && event.pointerId !== middleDragPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    forwardCanvasEvent("up", event);
    stopMiddleDragForwarding();
}

function handleWidgetPointerDown(event) {
    // Forward middle-button drag to the graph canvas so pan works over the widget.
    if (event.button !== 1) return;

    event.preventDefault();
    event.stopPropagation();
    middleDragPointerId = event.pointerId;
    forwardCanvasEvent("down", event);

    if (!middleDragActive) {
        middleDragActive = true;
        window.addEventListener("pointermove", handleWindowPointerMoveForPan, true);
        window.addEventListener("pointerup", handleWindowPointerUpForPan, true);
        window.addEventListener("pointercancel", handleWindowPointerUpForPan, true);
        window.addEventListener("blur", stopMiddleDragForwarding, true);
    }
}

function handleWidgetAuxClick(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
}


function getThumbnailRightClickMode() {
    if (!app?.ui?.settings) return THUMBNAIL_RIGHT_CLICK_DEFAULT;
    return app.ui.settings.getSettingValue(
        THUMBNAIL_RIGHT_CLICK_SETTING_ID,
        THUMBNAIL_RIGHT_CLICK_DEFAULT
    );
}

function openImageInNewTab(url) {
    if (!url) return;
    const newTab = window.open(url, "_blank", "noopener,noreferrer");
    if (newTab) newTab.opener = null;
}

function handleThumbnailContextMenu(event, imageUrl) {
    const mode = getThumbnailRightClickMode();

    if (mode === "ComfyUI Node") {
        // Let ComfyUI handle the node context menu.
        return;
    }

    if (mode === "Open Image") {
        event.preventDefault();
        event.stopPropagation();
        openImageInNewTab(imageUrl);
        return;
    }

    // Browser Default: keep browser context menu, but stop node-level menu.
    event.stopPropagation();
}

function ensureStyles() {
    if (document.getElementById("cg-image-chooser-widget-style")) return;
    const style = document.createElement("style");
    style.id = "cg-image-chooser-widget-style";
    style.textContent = `
    .cg-chooser-widget {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 12px;
        overflow: hidden;
    }
    .cg-chooser-grid-stage {
        flex: 1;
        width: 100%;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: hidden;
    }
    .cg-chooser-grid {
        display: grid;
        gap: 6px;
        width: 100%;
        max-width: 100%;
        max-height: 100%;
        overflow: hidden;
    }
    .cg-chooser-cell {
        position: relative;
        border-radius: 6px;
        border: 2px solid transparent;
        overflow: hidden;
        background: #151515;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .cg-chooser-cell.selected {
        border-color: #4caf50;
        box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.4);
    }
    .cg-chooser-cell img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
    }
    .cg-chooser-footer {
        display: flex;
        flex: 0 0 auto;
        justify-content: flex-end;
        gap: 8px;
        overflow: hidden;
    }
    .cg-chooser-footer button {
        border: none;
        border-radius: 4px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: 13px;
    }
    .cg-chooser-progress {
        background: #4caf50;
        color: #101010;
    }
    .cg-chooser-progress:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .cg-chooser-cancel {
        background: #c54a4a;
        color: #fff;
    }
    .cg-chooser-rerun {
        background: #8a6a00;
        color: #fff;
    }
    `;
    document.head.appendChild(style);
}

function findNode(detail) {
    if (!app.graph) return null;
    const graph = app.graph;
    const candidates = [];
    if (detail.display_id !== undefined && detail.display_id !== null) candidates.push(detail.display_id);
    if (detail.unique_id) {
        candidates.push(detail.unique_id);
        const parts = detail.unique_id.split(":");
        if (parts.length > 1) candidates.push(parts[0], parts.at(-1));
    }
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const key = candidate.toString();
        const node = graph._nodes_by_id?.[key];
        if (node?.isImageChooserClassicWidget) return node;
    }
    const nodes = graph._nodes ?? [];
    return nodes.find((n) => n?.isImageChooserClassicWidget && (n._ic_unique_id === detail.unique_id));
}

function ensureWidget(node) {
    let info = activeWidgets.get(node.id);
    if (info) return info;

    const container = document.createElement("div");
    container.className = "cg-chooser-widget";
    container.style.height = "100%";

    const domWidget = node.addDOMWidget("Chooser", "cg-image-chooser", container, {
        getValue() {
            return null;
        },
        setValue() {},
        hideOnZoom: false,
    });
    domWidget.serialize = false;
    if (domWidget.element instanceof HTMLElement) {
        domWidget.element.style.overflow = "hidden";
        if (domWidget.element.parentElement instanceof HTMLElement) {
            domWidget.element.parentElement.style.overflow = "hidden";
        }
    }

    info = {
        container,
        domWidget,
        gridStage: null,
        grid: null,
        progressBtn: null,
        cancelBtn: null,
        lastDetail: null,
        layout: null,
        wheelHandler: null,
        pointerDownHandler: null,
        auxClickHandler: null,
    };

    info.wheelHandler = (event) => handleWidgetWheel(event, container);
    container.addEventListener("wheel", info.wheelHandler, { passive: false });
    info.pointerDownHandler = (event) => handleWidgetPointerDown(event);
    container.addEventListener("pointerdown", info.pointerDownHandler, { passive: false });
    info.auxClickHandler = (event) => handleWidgetAuxClick(event);
    container.addEventListener("auxclick", info.auxClickHandler, { passive: false });

    activeWidgets.set(node.id, info);

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        if (info.wheelHandler) {
            container.removeEventListener("wheel", info.wheelHandler);
        }
        if (info.pointerDownHandler) {
            container.removeEventListener("pointerdown", info.pointerDownHandler);
        }
        if (info.auxClickHandler) {
            container.removeEventListener("auxclick", info.auxClickHandler);
        }
        activeWidgets.delete(this.id);
        if (currentActiveNode === this) currentActiveNode = null;
        domWidget.onRemove?.();
        return originalOnRemoved?.apply(this, args);
    };

    if (!node._ic_resizeHooked) {
        const originalOnResize = node.onResize;
        node.onResize = function (...args) {
            const result = originalOnResize?.apply(this, args);
            const suppress = this._ic_suppressResize;
            if (!suppress) this._ic_userSized = true;
            requestLayoutUpdate(this);
            return result;
        };
        node._ic_resizeHooked = true;
    }

    return info;
}

function extractRatioFromDetail(detail) {
    const urls = detail?.urls ?? [];
    for (const u of urls) {
        const w = Number(u.width);
        const h = Number(u.height);
        if (w > 0 && h > 0) return w / h;
        const metaRatio = Number(u.aspect_ratio ?? u.ratio);
        if (metaRatio > 0) return metaRatio;
    }
    const hint = Number(detail?.aspect_ratio ?? detail?.ratio);
    return hint > 0 ? hint : null;
}

function getThumbRatio(node, detail) {
    const cached = Number(node?._ic_thumb_ratio);
    if (cached > 0) return cached;
    const derived = extractRatioFromDetail(detail);
    const ratio = Number.isFinite(derived) && derived > 0 ? derived : FALLBACK_ASPECT;
    node._ic_thumb_ratio = ratio;
    return ratio;
}

function formatPx(value) {
    if (!Number.isFinite(value)) return "0px";
    if (value < 0) value = 0;
    const rounded = Math.floor(value * 100) / 100;
    return `${rounded}px`;
}

function determineLayout(node, detail) {
    const minWidth = 280;
    const maxAutoWidth = 420;
    const minHeight = 180;
    const maxAutoHeight = 420;
    const baseGap = 6;
    const padding = 12;
    const footerHeight = 52;
    const ratio = getThumbRatio(node, detail);

    const size = node.size ?? [];
    const userSized = !!node._ic_userSized;
    const rawWidth = Number(size[0]) || minWidth;
    const rawHeight = Number(size[1]) || minHeight;
    const minWidthForCalc = userSized ? MIN_CELL_EDGE + padding * 2 : minWidth;
    const minHeightForCalc = userSized ? MIN_CELL_EDGE + padding * 2 + footerHeight : minHeight;
    const currentWidth = Math.max(minWidthForCalc, rawWidth);
    const currentHeight = Math.max(minHeightForCalc, rawHeight);
    const availableWidth = Math.max(MIN_CELL_EDGE, currentWidth - padding * 2);
    const availableHeight = Math.max(MIN_CELL_EDGE, currentHeight - padding * 2 - footerHeight);

    const imageCount = Math.max(1, detail.urls?.length ?? 0);
    const maxColumns = Math.max(1, imageCount);

    let bestLayout = null;

    for (let columns = 1; columns <= maxColumns; columns++) {
        const rows = Math.max(1, Math.ceil(imageCount / columns));
        const emptySlots = rows * columns - imageCount;
        const columnGap = Math.min(
            baseGap,
            availableWidth / Math.max(columns * 8, 1),
            availableWidth / Math.max(imageCount * 6, 1)
        );
        const rowGap = Math.min(
            baseGap,
            availableHeight / Math.max(rows * 8, 1),
            availableHeight / Math.max(imageCount * 6, 1)
        );

        const widthSpace = availableWidth - (columns - 1) * columnGap;
        const heightSpace = availableHeight - (rows - 1) * rowGap;
        if (widthSpace <= 0 || heightSpace <= 0) continue;

        const widthConstraint = widthSpace / columns;
        const heightConstraint = heightSpace / rows;
        if (widthConstraint <= 0 || heightConstraint <= 0) continue;

        const widthFromHeight = heightConstraint * ratio;
        const cellWidth = Math.max(2, Math.min(widthConstraint, widthFromHeight));
        const cellHeight = cellWidth / ratio;
        if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellHeight <= 0) continue;

        const usedWidth = columns * cellWidth + (columns - 1) * columnGap;
        const usedHeight = rows * cellHeight + (rows - 1) * rowGap;
        if (usedWidth > availableWidth + 0.5 || usedHeight > availableHeight + 0.5) continue;

        const widthUsage = usedWidth / availableWidth;
        const heightUsage = usedHeight / availableHeight;
        const balance = Math.abs(columns - rows);
        const sizeScore = cellWidth * cellHeight;
        const fillPenalty = Math.abs(1 - widthUsage) + Math.abs(1 - heightUsage);
        const score = sizeScore - fillPenalty * sizeScore * 0.15 - emptySlots * 0.01 - balance * 0.05;

        if (!bestLayout || score > bestLayout.score) {
            bestLayout = {
                columns,
                rows,
                cellWidth,
                cellHeight,
                columnGap,
                rowGap,
                usedWidth,
                usedHeight,
                score,
            };
        }
    }

    if (!bestLayout) {
        // Fallback: single column that fills the available space.
        const columnGap = Math.min(baseGap, availableWidth / 12);
        const rowGap = Math.min(baseGap, availableHeight / Math.max(imageCount * 2, 1));
        const rows = imageCount;
        const widthConstraint = availableWidth;
        const heightConstraint = (availableHeight - (rows - 1) * rowGap) / rows;
        const widthFromHeight = heightConstraint * ratio;
        const cellWidth = Math.max(2, Math.min(widthConstraint, widthFromHeight));
        const cellHeight = cellWidth / ratio;
        bestLayout = {
            columns: 1,
            rows,
            cellWidth,
            cellHeight,
            columnGap,
            rowGap,
            usedWidth: cellWidth,
            usedHeight: rows * cellHeight + (rows - 1) * rowGap,
            score: 0,
        };
    }

    const widthScale = Math.min(1, availableWidth / bestLayout.usedWidth);
    const heightScale = Math.min(1, availableHeight / bestLayout.usedHeight);
    const scale = Math.min(widthScale, heightScale);

    const scaledCellWidth = bestLayout.cellWidth * scale;
    const scaledCellHeight = bestLayout.cellHeight * scale;
    const scaledUsedWidth = bestLayout.usedWidth * scale;
    const scaledUsedHeight = bestLayout.usedHeight * scale;

    const preferredWidth = Math.max(minWidth, Math.min(maxAutoWidth, scaledUsedWidth + padding * 2));
    const preferredHeight = Math.max(minHeight, Math.min(maxAutoHeight, scaledUsedHeight + padding * 2 + footerHeight));

    return {
        columns: bestLayout.columns,
        rows: bestLayout.rows,
        columnGap: bestLayout.columnGap * scale,
        rowGap: bestLayout.rowGap * scale,
        cellWidth: scaledCellWidth,
        cellHeight: scaledCellHeight,
        usedWidth: scaledUsedWidth,
        usedHeight: scaledUsedHeight,
        preferredWidth,
        preferredHeight,
        availableWidth,
        availableHeight,
    };
}

function updateNodeSize(node, width, height) {
    const currentWidth = Number(node.size?.[0]) || 0;
    const currentHeight = Number(node.size?.[1]) || 0;
    const sameWidth = Math.abs(currentWidth - width) < 0.5;
    const sameHeight = Math.abs(currentHeight - height) < 0.5;
    if (sameWidth && sameHeight) return;
    if (typeof node.setSize === "function") {
        node._ic_suppressResize = true;
        node.setSize([width, height]);
        node._ic_suppressResize = false;
    } else {
        node.size = [width, height];
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function applyLayout(node, detail, info, options = {}) {
    if (!detail || !info?.grid) return;
    const layout = determineLayout(node, detail);
    info.layout = layout;

    const container = info.container;
    const stage = info.gridStage;
    const grid = info.grid;

    const measuredStageWidth = stage?.clientWidth;
    const measuredStageHeight = stage?.clientHeight;
    const fallbackWidth = layout.availableWidth ?? layout.usedWidth ?? MIN_CELL_EDGE;
    const fallbackHeight = layout.availableHeight ?? layout.usedHeight ?? MIN_CELL_EDGE;
    const stageWidth = Math.max(
        MIN_CELL_EDGE,
        Number.isFinite(measuredStageWidth) && measuredStageWidth > 0 ? measuredStageWidth : fallbackWidth
    );
    const stageHeight = Math.max(
        MIN_CELL_EDGE,
        Number.isFinite(measuredStageHeight) && measuredStageHeight > 0 ? measuredStageHeight : fallbackHeight
    );
    const widthScale = layout.usedWidth > 0 ? Math.min(1, stageWidth / layout.usedWidth) : 1;
    const heightScale = layout.usedHeight > 0 ? Math.min(1, stageHeight / layout.usedHeight) : 1;
    const stageScale = Math.max(0, Math.min(widthScale, heightScale, 1));

    const cellWidth = layout.cellWidth * stageScale;
    const cellHeight = layout.cellHeight * stageScale;
    const columnGap = layout.columnGap * stageScale;
    const rowGap = layout.rowGap * stageScale;
    const usedWidth = layout.usedWidth * stageScale;
    const usedHeight = layout.usedHeight * stageScale;

    grid.style.gridTemplateColumns = `repeat(${layout.columns}, ${formatPx(cellWidth)})`;
    grid.style.gridAutoRows = formatPx(cellHeight);
    grid.style.columnGap = formatPx(columnGap);
    grid.style.rowGap = formatPx(rowGap);
    grid.style.width = "100%";
    grid.style.height = formatPx(usedHeight);
    grid.style.maxHeight = formatPx(usedHeight);
    grid.style.maxWidth = formatPx(usedWidth);
    grid.style.minWidth = "0";
    grid.style.minHeight = "0";
    grid.style.overflow = "hidden";
    grid.style.margin = "0 auto";
    grid.style.justifyContent = "center";
    grid.style.alignContent = "center";
    grid.style.transform = "scale(1)";

    if (stage) stage.style.overflow = "hidden";
    container.style.minHeight = "0px";
    // In app mode (ComfyUI "app view"), ComfyUI mounts our element inside a
    // WidgetDOM wrapper div (class "flex flex-col *:flex-1") that has no
    // overflow:hidden. Propagate the hidden overflow upward whenever the
    // element has been mounted into a parent so that wrapper can never scroll.
    if (container.parentElement instanceof HTMLElement) {
        container.parentElement.style.overflow = "hidden";
    }

    if (info.domWidget) {
        // Always report the current node width back unchanged so ComfyUI never
        // uses computeSize to resize the node horizontally.  Only the height
        // hint is ours to control.
        info.domWidget.computeSize = (width) => [width, layout.preferredHeight];
    }

    if (!node._ic_userSized && options.allowSizeUpdate !== false) {
        updateNodeSize(node, layout.preferredWidth, layout.preferredHeight);
    }
}

function requestLayoutUpdate(node) {
    if (!node?._ic_last_detail) return;
    if (node._ic_layoutPending) return;
    node._ic_layoutPending = true;
    const scheduler = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    scheduler(() => {
        node._ic_layoutPending = false;
        const detail = node._ic_last_detail;
        if (!detail) return;
        const info = activeWidgets.get(node.id);
        if (!info?.grid) return;
        applyLayout(node, detail, info, { allowSizeUpdate: false });
    });
}

function getCanvasZoom() {
    const zoom = Number(app?.canvas?.ds?.scale);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function renderChooser(node, detail) {
    const info = ensureWidget(node);
    info.lastDetail = detail;
    node._ic_last_detail = detail;
    const container = info.container;
    container.innerHTML = "";

    const stage = document.createElement("div");
    stage.className = "cg-chooser-grid-stage";

    const grid = document.createElement("div");
    grid.className = "cg-chooser-grid";
    stage.appendChild(grid);

    info.gridStage = stage;
    info.grid = grid;

    const footer = document.createElement("div");
    footer.className = "cg-chooser-footer";

    const progressBtn = document.createElement("button");
    progressBtn.className = "cg-chooser-progress";
    progressBtn.textContent = "Progress";
    progressBtn.disabled = true;
    progressBtn.addEventListener("click", () => sendSelection(node));
    info.progressBtn = progressBtn;

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cg-chooser-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
        send_cancel();
        clearSelection(node);
    });
    info.cancelBtn = cancelBtn;

    const rerunBtn = document.createElement("button");
    rerunBtn.className = "cg-chooser-rerun";
    rerunBtn.textContent = "Rerun";
    rerunBtn.addEventListener("click", () => {
        send_cancel();
        app.queuePrompt(0, 1);
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(rerunBtn);
    footer.appendChild(progressBtn);
    container.appendChild(stage);
    container.appendChild(footer);

    const sharedRatio = getThumbRatio(node, detail);
    const cellAspect = Number.isFinite(sharedRatio) && sharedRatio > 0
        ? `${sharedRatio}` : "1";

    node._ic_selection = new Set();
    (detail.urls ?? []).forEach((u, idx) => {
        const cell = document.createElement("div");
        cell.className = "cg-chooser-cell";
        cell.dataset.index = String(idx);
        cell.style.aspectRatio = cellAspect;

        const img = document.createElement("img");
        img.src = api.apiURL(
            `/view?filename=${encodeURIComponent(u.filename)}&type=${u.type}&subfolder=${encodeURIComponent(u.subfolder ?? "")}`
        );
        img.alt = `Image ${idx + 1}`;
        if (idx === 0) {
            img.addEventListener("load", () => {
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const loadedRatio = img.naturalWidth / img.naturalHeight;
                    if (Math.abs(loadedRatio - sharedRatio) > 0.01) {
                        node._ic_thumb_ratio = loadedRatio;
                        const newAspect = String(loadedRatio);
                        info.grid?.querySelectorAll(".cg-chooser-cell").forEach((c) => {
                            c.style.aspectRatio = newAspect;
                        });
                        requestLayoutUpdate(node);
                    }
                }
            }, { once: true });
        }
        cell.addEventListener("contextmenu", (event) => {
            handleThumbnailContextMenu(event, img.src);
        });
        cell.appendChild(img);
        cell.addEventListener("click", (event) => {
            event.preventDefault();
            toggleSelection(node, idx);
        });
        grid.appendChild(cell);
    });

    applyLayout(node, detail, info);
    updateButtons(node);
}

function toggleSelection(node, index) {
    const sel = node._ic_selection ?? (node._ic_selection = new Set());
    if (sel.has(index)) sel.delete(index);
    else sel.add(index);
    updateSelections(node);
    if (node._ic_progress_first_pick && sel.size > 0) {
        sendSelection(node);
    }
}

function updateSelections(node) {
    const sel = node._ic_selection ?? new Set();
    const grid = activeWidgets.get(node.id)?.grid;
    if (!grid) return;
    grid.querySelectorAll(".cg-chooser-cell").forEach((cell) => {
        const idx = Number(cell.dataset.index);
        if (sel.has(idx)) cell.classList.add("selected");
        else cell.classList.remove("selected");
    });
    updateButtons(node);
}

function clearSelection(node) {
    node._ic_selection = new Set();
    updateSelections(node);
}

function updateButtons(node) {
    const info = activeWidgets.get(node.id);
    if (!info) return;
    const selSize = node._ic_selection?.size ?? 0;
    if (info.progressBtn) info.progressBtn.disabled = selSize === 0;
}

function sendSelection(node) {
    const target = node._ic_unique_id ?? node.id;
    const sel = Array.from(node._ic_selection ?? []);
    if (sel.length === 0) return;
    sel.sort((a, b) => a - b);
    send_message(target, sel.join(","));
}

function handleEvent(detail) {
    const node = findNode(detail);
    if (!node) {
        console.warn("Image Chooser Classic: unable to locate node", detail);
        return;
    }
    node._ic_unique_id = detail.unique_id ?? node._ic_unique_id ?? node.id;
    node._ic_display_id = detail.display_id ?? node._ic_display_id ?? node.id;
    node._ic_progress_first_pick = !!detail.progress_first_pick;
    renderChooser(node, detail);
    currentActiveNode = node;
}

function handleKey(event) {
    if (!currentActiveNode) return;
    if (!app.graph?._nodes.includes(currentActiveNode)) {
        currentActiveNode = null;
        return;
    }
    if (!app.ui.settings.getSettingValue("ImageChooser.hotkeys", true)) return;
    const sel = currentActiveNode._ic_selection ?? (currentActiveNode._ic_selection = new Set());
    if (event.key === "0") {
        if (sel.size > 0) sendSelection(currentActiveNode);
        else send_cancel();
        event.preventDefault();
        return;
    }
    const digits = "123456789";
    const idx = digits.indexOf(event.key);
    if (idx >= 0) {
        toggleSelection(currentActiveNode, idx);
        event.preventDefault();
    }
}

function clearWidgetState() {
    stopMiddleDragForwarding();
    activeWidgets.forEach((info, nodeId) => {
        info.grid?.querySelectorAll(".cg-chooser-cell").forEach((cell) => cell.classList.remove("selected"));
        if (info.progressBtn) info.progressBtn.disabled = true;
        const node = app.graph?._nodes_by_id?.[nodeId];
        if (node) node._ic_selection = new Set();
    });
    currentActiveNode = null;
}

app.registerExtension({
    name: "cg.custom.image_chooser.widget",
    init() {
        ensureStyles();
        window.addEventListener("keydown", handleKey, true);
    },
    setup() {
        api.addEventListener(EVENT_NAME, (evt) => {
            playAlertIfEnabled();
            handleEvent(evt.detail ?? {});
        });
        api.addEventListener("execution_start", clearWidgetState);
        api.addEventListener("execution_success", clearWidgetState);
        api.addEventListener("execution_error", clearWidgetState);
        api.addEventListener("execution_interrupted", clearWidgetState);
    },
    async beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
        if (nodeType?.comfyClass === "Image Chooser Classic") {
            nodeType.prototype.isImageChooserClassicWidget = true;
            const originalOnAdded = nodeType.prototype.onAdded;
            nodeType.prototype.onAdded = function (...args) {
                const res = originalOnAdded?.apply(this, args);
                ensureWidget(this);
                return res;
            };

            const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function (...args) {
                const res = originalOnDrawForeground?.apply(this, args);
                const info = activeWidgets.get(this.id);
                if (!info) return res;

                const zoom = getCanvasZoom();
                if (info.lastZoom !== zoom) {
                    info.lastZoom = zoom;
                    requestLayoutUpdate(this);
                }

                return res;
            };
        }
    },
});
