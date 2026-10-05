(function () {
    "use strict";

    const MOD = "DoL BSA Beauty Switcher";
    const VERSION = "0.3.18";
    const TAG = "[BSABeautySwitcher]";
    const STORAGE_MANAGED = "BSABeautySwitcher.managedTypes";
    const STORAGE_FOLLOWERS = "BSABeautySwitcher.followers";
    const STORAGE_FACE = "BSABeautySwitcher.faceFallback";
    const FACE_PREFIX = "img/face/";

    let originalLoadImage = null;

    function bsa() {
        return window.addonBeautySelectorAddon || null;
    }

    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function getManagedTypes() {
        const saved = loadJson(STORAGE_MANAGED, []);
        return Array.isArray(saved) ? [...new Set(saved.filter(x => typeof x === "string"))] : [];
    }

    function setManagedTypes(types) {
        saveJson(STORAGE_MANAGED, [...new Set(types.filter(x => typeof x === "string"))]);
        window.dispatchEvent(new CustomEvent("bsaBeautySwitcher:managedTypesChanged"));
    }

    function getFollowersMap() {
        const saved = loadJson(STORAGE_FOLLOWERS, {});
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
        const out = {};
        for (const [mainType, list] of Object.entries(saved)) {
            if (!Array.isArray(list)) continue;
            const clean = [...new Set(list.filter(x => typeof x === "string" && x && x !== mainType))];
            if (clean.length) out[mainType] = clean;
        }
        return out;
    }

    function setFollowers(mainType, followers) {
        const map = getFollowersMap();
        const clean = [...new Set((followers || []).filter(x => typeof x === "string" && x && x !== mainType))];

        // 每個附屬包只屬於一個主美化。
        for (const key of Object.keys(map)) {
            map[key] = map[key].filter(x => !clean.includes(x));
            if (!map[key].length) delete map[key];
        }
        if (clean.length) map[mainType] = clean;
        else delete map[mainType];
        saveJson(STORAGE_FOLLOWERS, map);
    }

    function getFollowers(mainType) {
        return getFollowersMap()[mainType] || [];
    }

    function getFaceFallbackEnabled() {
        return loadJson(STORAGE_FACE, true) !== false;
    }

    function setFaceFallbackEnabled(enabled) {
        saveJson(STORAGE_FACE, !!enabled);
        refreshRenderer();
    }

    function getAllTypes() {
        return bsa()?.getTypeOrder?.() || [];
    }

    function getManagedItems() {
        const wanted = new Set(getManagedTypes());
        return getAllTypes().filter(item => wanted.has(item.type));
    }

    function getActiveManagedType() {
        const api = bsa();
        if (!api) return null;
        const managed = new Set(getManagedTypes());
        return (api.typeOrderUsed || []).find(item => managed.has(item.type))?.type || null;
    }

    async function setActiveManagedType(typeName) {
        const api = bsa();
        if (!api) throw new Error(`${TAG} BeautySelectorAddon not found.`);

        const managedNames = new Set(getManagedTypes());
        const all = getAllTypes();
        const selected = typeName == null ? null : all.find(item => managedNames.has(item.type) && item.type === typeName);
        if (typeName != null && !selected) throw new Error(`${TAG} Managed type not found: ${typeName}`);

        // 主美化互斥切換，附屬包跟隨主美化；其他 BSA Type 保持原狀。
        const followerMap = getFollowersMap();
        const controlledNames = new Set(managedNames);
        for (const list of Object.values(followerMap)) {
            for (const follower of list) controlledNames.add(follower);
        }

        const next = (api.typeOrderUsed || []).filter(item => !controlledNames.has(item.type));
        if (selected) {
            next.push(selected);
            for (const followerName of getFollowers(selected.type)) {
                const follower = all.find(item => item.type === followerName);
                if (follower) next.push(follower);
            }
        }

        api.typeOrderUsed = next;
        await api.saveOrder(next.map(item => item.type));
        scheduleRefresh(100);
        return selected?.type || null;
    }

    function unique(list) {
        return [...new Set(list.filter(Boolean))];
    }

    // 建立臉部素材的相容回退候選。
    function buildFaceCandidates(src) {
        if (typeof src !== "string" || !src.startsWith(FACE_PREFIX)) {
            return [];
        }

        const relative = src.slice(FACE_PREFIX.length);
        const parts = relative.split("/");

        if (parts.length >= 3) {
            const style = parts[0];
            const variant = parts[1];
            const rest = parts.slice(2).join("/");

            if (style === "masks") {
                return [src];
            }

            return unique([
                src,
                `${FACE_PREFIX}${style}/default/${rest}`,
                `${FACE_PREFIX}default/${variant}/${rest}`,
                `${FACE_PREFIX}default/${rest}`,
                `${FACE_PREFIX}default/default/${rest}`
            ]);
        }

        if (parts.length === 2) {
            const style = parts[0];
            const file = parts[1];

            if (style === "masks") {
                return [src];
            }

            return unique([
                src,
                `${FACE_PREFIX}default/${file}`
            ]);
        }

        return [src];
    }

    // 透過 ImageLoaderHook 檢查素材是否存在。
    function checkImageExists(src) {
        const hooker = window.modImgLoaderHooker;
        if (!hooker || typeof hooker.checkImageExist !== "function") {
            return null; // 無法判斷時保留原始路徑
        }
        try {
            return !!hooker.checkImageExist(src);
        } catch (e) {
            console.warn(TAG, "checkImageExist failed; keep original src:", src, e);
            return null;
        }
    }

    function patchedLoadImage(src, layer, successCallback, errorCallback) {
        if (!getFaceFallbackEnabled() || typeof src !== "string" || !src.startsWith(FACE_PREFIX)) {
            return originalLoadImage.call(Renderer.ImageLoader, src, layer, successCallback, errorCallback);
        }

        const candidates = buildFaceCandidates(src);
        if (!candidates.length) {
            return originalLoadImage.call(Renderer.ImageLoader, src, layer, successCallback, errorCallback);
        }

        console.groupCollapsed(`${TAG} FACE ${layer?.name || "unnamed"}`);
        console.log("Request:", src);
        console.log("Candidates:", candidates);

        // 原始素材存在或無法判斷時維持原路徑。
        const f0Exists = checkImageExists(src);
        console.log("F0", f0Exists === null ? "UNKNOWN" : (f0Exists ? "HIT" : "MISS"), src);
        if (f0Exists !== false) {
            console.log("Resolved:", src);
            console.groupEnd();
            return originalLoadImage.call(Renderer.ImageLoader, src, layer, successCallback, errorCallback);
        }

        // 原始素材確認不存在後，依序尋找可用候選。
        for (let i = 1; i < candidates.length; i++) {
            const candidate = candidates[i];
            const exists = checkImageExists(candidate);
            console.log(`F${i}`, exists === null ? "UNKNOWN" : (exists ? "HIT" : "MISS"), candidate);

            if (exists === true) {
                console.log("Resolved:", candidate);
                console.groupEnd();
                return originalLoadImage.call(Renderer.ImageLoader, candidate, layer, successCallback, errorCallback);
            }

            // 中途無法判斷時回到原始路徑。
            if (exists === null) {
                console.log("Existence unknown; keep original:", src);
                console.groupEnd();
                return originalLoadImage.call(Renderer.ImageLoader, src, layer, successCallback, errorCallback);
            }
        }

        // 沒有可用候選時交回正常載入流程。
        console.log("FACE MISS; keep normal loader behaviour:", src);
        console.groupEnd();
        return originalLoadImage.call(Renderer.ImageLoader, src, layer, successCallback, errorCallback);
    }

    let refreshTimer = null;

    function scheduleRefresh(delay = 100) {
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refreshRenderer();
        }, delay);
    }

    function refreshRenderer() {
        const models = new Set();
        const lastLayers = Renderer.lastCall?.[1];
        if (Array.isArray(lastLayers)) {
            for (const layer of lastLayers) if (layer?.model) models.add(layer.model);
        }
        Renderer.ImageCaches = {};
        Renderer.ImageErrors = {};
        if (models.size) {
            for (const model of models) {
                try {
                    Renderer.invalidateLayerCaches(model.layerList || []);
                    model.redraw?.();
                } catch (e) {
                    console.error(TAG, "Model refresh failed:", e);
                }
            }
            return;
        }
        if (Array.isArray(lastLayers)) Renderer.invalidateLayerCaches(lastLayers);
        try { Renderer.composeLayersAgain?.(); } catch (e) { console.error(TAG, "Refresh failed:", e); }
    }

    function applyUiStyles(root) {
        root.style.padding = "12px";
        root.style.border = "1px solid #444";
        root.style.background = "#111";
        root.style.marginBottom = "10px";
        root.style.fontSize = "14px";
        root.style.borderRadius = "4px";
        root.style.lineHeight = "1.5";
    }

    function makeUiTitle(text) {
        const title = document.createElement("div");
        title.textContent = text;
        title.style.fontWeight = "bold";
        title.style.fontSize = "16px";
        title.style.color = "#FFD700";
        title.style.marginBottom = "8px";
        return title;
    }

    function makeUiHint(text) {
        const hint = document.createElement("div");
        hint.textContent = text;
        hint.style.fontSize = "13px";
        hint.style.color = "#aaa";
        hint.style.lineHeight = "1.5";
        hint.style.marginBottom = "8px";
        return hint;
    }

    function makeSectionHeading(text, countText = "") {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "baseline";
        row.style.gap = "0.75em";
        row.style.borderTop = "1px solid #333";
        row.style.marginTop = "12px";
        row.style.paddingTop = "8px";
        row.style.marginBottom = "6px";

        const title = document.createElement("strong");
        title.textContent = text;
        title.style.color = "#FFD700";
        row.appendChild(title);

        if (countText) {
            const count = document.createElement("span");
            count.textContent = countText;
            count.style.color = "#aaa";
            count.style.fontSize = "13px";
            row.appendChild(count);
        }
        return row;
    }

    function makeScrollBox() {
        const box = document.createElement("div");
        box.style.maxHeight = "12em";
        box.style.overflowY = "auto";
        box.style.padding = "0.45em 0.55em";
        box.style.margin = "0.35em 0 0.75em";
        box.style.border = "1px solid #444";
        box.style.borderRadius = "4px";
        box.style.background = "#181818";
        return box;
    }

    function styleControl(control) {
        control.style.maxWidth = "100%";
        control.style.boxSizing = "border-box";
        return control;
    }

    function createUiSortSession() {
        const managed = new Set(getManagedTypes());
        const followers = new Map();
        for (const mainType of managed) {
            followers.set(mainType, new Set(getFollowers(mainType)));
        }
        return { managed, followers };
    }

    function makeTypeSetupUi(sortSession = createUiSortSession()) {
        const root = document.createElement("div");
        root.className = "bsa-art-setup";
        applyUiStyles(root);

        const api = bsa();
        if (!api) {
            root.textContent = "BeautySelectorAddon 尚未就緒。";
            return root;
        }

        // 記錄開啟面板時的勾選狀態，只用於 UI 置頂排序。
        const entryManaged = sortSession.managed;
        const entryFollowers = sortSession.followers;

        const getEntryFollowers = mainType => {
            // 本次開啟後新增的主美化，附屬包暫不參與置頂排序。
            return entryFollowers.get(mainType) || new Set();
        };

        const selectedFirst = (items, selectedSet) => {
            const selected = [];
            const unselected = [];
            for (const item of items) {
                (selectedSet.has(item.type) ? selected : unselected).push(item);
            }
            return selected.concat(unselected);
        };

        // 記錄本次開啟期間的清單捲動位置。
        let managedScrollTop = 0;
        const followerScrollTop = new Map();

        const render = (preferredMain = null) => {
            root.replaceChildren();

            const all = getAllTypes();
            const managedNow = getManagedTypes();
            const managedSet = new Set(managedNow);

            root.appendChild(makeUiTitle("美化包設定"));
            root.appendChild(makeUiHint(
                "在這裡指定哪些 BSA 模組屬於可快速切換的人模美化，以及切換時需要一起啟用的附屬模組。"
            ));

            root.appendChild(makeSectionHeading("管理美化包", `已選 ${managedNow.length}`));
            root.appendChild(makeUiHint(
                "選擇要加入快速切換的人模美化。建議僅勾選完整的人模美化，例如 AU美化、Goose美化等。服裝、髮型、單獨部件或其他一般 BSA 模組通常不需要加入此處。"
            ));

            const managedBox = makeScrollBox();
            const managedDisplayItems = selectedFirst(all, entryManaged);
            for (const item of managedDisplayItems) {
                const label = document.createElement("label");
                label.style.display = "block";
                label.style.padding = "0.15em 0";

                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = managedSet.has(item.type);
                cb.addEventListener("change", () => {
                    managedScrollTop = managedBox.scrollTop;
                    const next = new Set(getManagedTypes());
                    cb.checked ? next.add(item.type) : next.delete(item.type);
                    setManagedTypes([...next]);
                    render(cb.checked ? item.type : null);
                });

                label.append(cb, ` [${item.modRef?.name || "?"}] ${item.type}`);
                managedBox.appendChild(label);
            }
            root.appendChild(managedBox);
            managedBox.scrollTop = managedScrollTop;

            if (!managedNow.length) {
                root.appendChild(makeUiHint(
                    "尚未選擇人模美化。勾選至少一個美化包後，即可設定附屬模組並在上方快速切換。"
                ));
                return;
            }

            const initialMain = managedSet.has(preferredMain)
                ? preferredMain
                : managedNow[0];

            const followerHeading = makeSectionHeading("附屬美化包");
            root.appendChild(followerHeading);
            root.appendChild(makeUiHint(
                "附屬包是需要跟隨某套人模美化一起啟用或停用的 BSA 模組。只有以該美化為前置，或必須配合該美化使用的模組才建議勾選。"
            ));

            const mainLabel = document.createElement("label");
            mainLabel.style.display = "block";
            mainLabel.style.margin = "0.45em 0 0.65em";

            const mainTitle = document.createElement("strong");
            mainTitle.textContent = "主美化包：";
            mainLabel.appendChild(mainTitle);

            const mainSelect = styleControl(document.createElement("select"));
            mainSelect.style.display = "block";
            mainSelect.style.width = "100%";
            mainSelect.style.marginTop = "0.25em";
            for (const mainType of managedNow) {
                const item = all.find(x => x.type === mainType);
                const option = document.createElement("option");
                option.value = mainType;
                option.textContent = `[${item?.modRef?.name || "?"}] ${mainType}`;
                mainSelect.appendChild(option);
            }
            mainSelect.value = initialMain;
            mainLabel.appendChild(mainSelect);
            root.appendChild(mainLabel);

            const followerArea = document.createElement("div");
            root.appendChild(followerArea);

            const renderFollowers = mainType => {
                followerArea.replaceChildren();

                const selected = new Set(getFollowers(mainType));
                const mainItem = all.find(x => x.type === mainType);
                const mainName = mainItem?.modRef?.name || mainType;

                followerArea.appendChild(makeUiHint(
                    `建議僅勾選以「${mainName}」為前置，或必須配合「${mainName}」使用的模組。不確定的模組請保持未勾選。`
                ));
                followerArea.appendChild(
                    makeSectionHeading("一起啟用的附屬包", `已選 ${selected.size}`)
                );

                const followerBox = makeScrollBox();
                let available = 0;
                const followerCandidates = all.filter(item => !managedSet.has(item.type));
                const followerDisplayItems = selectedFirst(
                    followerCandidates,
                    getEntryFollowers(mainType)
                );

                for (const item of followerDisplayItems) {
                    available++;

                    const label = document.createElement("label");
                    label.style.display = "block";
                    label.style.padding = "0.15em 0";

                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = selected.has(item.type);
                    cb.addEventListener("change", () => {
                        followerScrollTop.set(mainType, followerBox.scrollTop);
                        const next = new Set(getFollowers(mainType));
                        cb.checked ? next.add(item.type) : next.delete(item.type);
                        setFollowers(mainType, [...next]);
                        renderFollowers(mainType);
                    });

                    label.append(cb, ` [${item.modRef?.name || "?"}] ${item.type}`);
                    followerBox.appendChild(label);
                }

                if (!available) {
                    const empty = document.createElement("div");
                    empty.textContent = "沒有可設定的附屬美化包。";
                    empty.style.color = "#aaa";
                    followerBox.appendChild(empty);
                }

                followerArea.appendChild(followerBox);
                followerBox.scrollTop = followerScrollTop.get(mainType) || 0;
            };

            mainSelect.addEventListener("change", () => {
                // 切換主美化時，附屬包清單從頂端開始。
                followerScrollTop.set(mainSelect.value, 0);
                renderFollowers(mainSelect.value);
            });
            renderFollowers(initialMain);
        };

        render();
        return root;
    }

    function makeManagerUi() {
        const root = document.createElement("div");
        root.className = "bsa-beauty-switcher";
        applyUiStyles(root);

        const api = bsa();
        if (!api) {
            root.textContent = "BeautySelectorAddon 尚未就緒。";
            return root;
        }

        const render = () => {
            root.replaceChildren();

            const managed = getManagedItems();
            const active = getActiveManagedType();

            root.appendChild(makeUiTitle("美化切換"));
            root.appendChild(makeUiHint(
                "用於安裝多套 BSA 人模美化時，快速切換目前使用的人模美化及其附屬模組。切換時只會控制下方「管理美化包」中指定的模組，其他 BSA 模組不受影響。"
            ));

            const activeTitle = document.createElement("strong");
            activeTitle.textContent = "當前美化";
            activeTitle.style.display = "block";
            activeTitle.style.marginBottom = "0.3em";
            root.appendChild(activeTitle);

            if (managed.length === 0) {
                const value = document.createElement("div");
                value.textContent = "依 BSA 原設定";
                value.style.color = "#aaa";
                value.style.marginBottom = "0.6em";
                root.appendChild(value);
                root.appendChild(makeUiHint(
                    "尚未指定要管理的人模美化。請先在下方「管理美化包」中勾選要加入快速切換的美化。"
                ));
            } else {
                const select = styleControl(document.createElement("select"));
                select.style.width = "100%";
                select.style.marginBottom = "0.45em";

                const off = document.createElement("option");
                off.value = "";
                off.textContent = "關閉已管理的美化";
                select.appendChild(off);

                for (const item of managed) {
                    const option = document.createElement("option");
                    option.value = item.type;
                    option.textContent = `[${item.modRef?.name || "?"}] ${item.type}`;
                    select.appendChild(option);
                }
                select.value = active || "";
                select.addEventListener("change", async () => {
                    await setActiveManagedType(select.value || null);
                });
                root.appendChild(select);
                root.appendChild(makeUiHint(
                    "選擇「關閉已管理的美化」時，將停用由本模組管理的人模美化並使用原版人物資源；其他未交由本模組管理的 BSA 模組不受影響。"
                ));
            }

            const faceSection = document.createElement("div");
            faceSection.style.borderTop = "1px solid #333";
            faceSection.style.marginTop = "10px";
            faceSection.style.paddingTop = "8px";

            const faceLabel = document.createElement("label");
            faceLabel.style.display = "block";
            faceLabel.style.fontWeight = "bold";
            const face = document.createElement("input");
            face.type = "checkbox";
            face.checked = getFaceFallbackEnabled();
            face.addEventListener("change", () => setFaceFallbackEnabled(face.checked));
            faceLabel.append(face, " 臉部素材相容回退");
            faceSection.appendChild(faceLabel);
            faceSection.appendChild(makeUiHint(
                "目前人模缺少某個臉部素材時，自動嘗試使用可用的預設素材，降低切換不同人模後臉部部件消失的情況。"
            ));
            root.appendChild(faceSection);
        };

        window.addEventListener("bsaBeautySwitcher:managedTypesChanged", render);
        render();
        return root;
    }

    function closeQuickUi() {
        const backdrop = document.getElementById("bsaBeautySwitcherQuickBackdrop");
        backdrop?.__bsaBeautySwitcherCleanup?.();
        backdrop?.remove();
    }

    function openFullUi() {
        closeQuickUi();
        try {
            new Wikifier(null, '<<maplebirchReplace "bsaBeautySwitcher" "title">>');
        } catch (e) {
            console.error(TAG, "開啟完整設定失敗:", e);
        }
    }

    function openQuickUi() {
        closeQuickUi();

        const backdrop = document.createElement("div");
        backdrop.id = "bsaBeautySwitcherQuickBackdrop";
        backdrop.className = "bsa-beauty-quick-backdrop";

        const dialog = document.createElement("div");
        dialog.className = "bsa-beauty-quick-dialog";
        backdrop.appendChild(dialog);

        backdrop.addEventListener("click", e => {
            if (e.target === backdrop) closeQuickUi();
        });

        const render = () => {
            dialog.replaceChildren();

            const header = document.createElement("div");
            header.className = "bsa-beauty-quick-header";

            const title = document.createElement("div");
            title.className = "bsa-beauty-quick-title";
            title.textContent = "美化切換";

            const close = document.createElement("button");
            close.type = "button";
            close.className = "bsa-beauty-quick-close";
            close.textContent = "×";
            close.addEventListener("click", closeQuickUi);
            header.append(title, close);
            dialog.appendChild(header);

            const managed = getManagedItems();
            const active = getActiveManagedType();

            if (!managed.length) {
                dialog.appendChild(makeUiHint("尚未設定要快速切換的人模美化。請先進入完整設定。"));
            } else {
                const list = document.createElement("div");
                list.className = "bsa-beauty-quick-list";

                const addItem = (label, type) => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "bsa-beauty-quick-item";
                    const isActive = (type || null) === (active || null);
                    if (isActive) button.classList.add("is-active");
                    button.textContent = `${isActive ? "✓ " : ""}${label}`;
                    button.addEventListener("click", async () => {
                        try {
                            await setActiveManagedType(type);
                            render();
                        } catch (e) {
                            console.error(TAG, "切換美化失敗:", e);
                        }
                    });
                    list.appendChild(button);
                };

                addItem("關閉已管理的美化", null);
                for (const item of managed) {
                    addItem(`[${item.modRef?.name || "?"}] ${item.type}`, item.type);
                }
                dialog.appendChild(list);
            }

            const faceLabel = document.createElement("label");
            faceLabel.className = "bsa-beauty-quick-face";
            const face = document.createElement("input");
            face.type = "checkbox";
            face.checked = getFaceFallbackEnabled();
            face.addEventListener("change", () => setFaceFallbackEnabled(face.checked));
            faceLabel.append(face, " 臉部素材相容回退");
            dialog.appendChild(faceLabel);

            const actions = document.createElement("div");
            actions.className = "bsa-beauty-quick-actions";
            const full = document.createElement("button");
            full.type = "button";
            full.textContent = "完整設定";
            full.addEventListener("click", openFullUi);
            actions.appendChild(full);
            dialog.appendChild(actions);
        };

        render();
        document.body.appendChild(backdrop);

        const positionDialog = () => {
            const anchor = document.querySelector("#mobileStats > .bsaBeautySwitcherIconBtn")
                || document.querySelector(".bsaBeautySwitcherIconBtn");
            if (!anchor?.isConnected || !dialog.isConnected) return;

            const gap = 8;
            const edge = 12;
            const anchorRect = anchor.getBoundingClientRect();
            const dialogRect = dialog.getBoundingClientRect();

            let left = anchorRect.left - dialogRect.width - gap;
            if (left < edge) {
                const rightSide = anchorRect.right + gap;
                if (rightSide + dialogRect.width <= window.innerWidth - edge) {
                    left = rightSide;
                } else {
                    left = Math.max(edge, Math.min(
                        anchorRect.left,
                        window.innerWidth - dialogRect.width - edge
                    ));
                }
            }

            let top = anchorRect.top;
            if (top + dialogRect.height > window.innerHeight - edge) {
                top = window.innerHeight - dialogRect.height - edge;
            }
            top = Math.max(edge, top);

            dialog.style.left = `${Math.round(left)}px`;
            dialog.style.top = `${Math.round(top)}px`;
        };

        requestAnimationFrame(positionDialog);
        window.addEventListener("resize", positionDialog, { passive: true });
        window.addEventListener("scroll", positionDialog, { passive: true, capture: true });

        backdrop.__bsaBeautySwitcherCleanup = () => {
            window.removeEventListener("resize", positionDialog);
            window.removeEventListener("scroll", positionDialog, true);
        };
    }

    function toggleQuickUi() {
        if (document.getElementById("bsaBeautySwitcherQuickBackdrop")) closeQuickUi();
        else openQuickUi();
    }

    function installFaceFallback(force = false) {
        if (!window.Renderer?.ImageLoader?.loadImage) return false;

        let current = Renderer.ImageLoader.loadImage;
        if (current === patchedLoadImage) {
            if (!force) return true;
            current = patchedLoadImage.__bsaBeautySwitcherOriginal || originalLoadImage;
        }
        if (typeof current !== "function") return false;

        originalLoadImage = current;
        patchedLoadImage.__bsaBeautySwitcher = true;
        patchedLoadImage.__bsaBeautySwitcherOriginal = originalLoadImage;
        Renderer.ImageLoader.loadImage = patchedLoadImage;
        return true;
    }

    function faceHookStatus() {
        const current = window.Renderer?.ImageLoader?.loadImage;
        return {
            installed: current === patchedLoadImage,
            outermost: current === patchedLoadImage,
            current,
            wrappedOriginal: patchedLoadImage.__bsaBeautySwitcherOriginal || originalLoadImage || null
        };
    }

    window.BSABeautySwitcher = {
        version: VERSION,
        getAllTypes,
        getManagedTypes,
        setManagedTypes,
        getFollowersMap,
        getFollowers,
        setFollowers,
        getManagedItems,
        getActiveManagedType,
        setActiveManagedType,
        getFaceFallbackEnabled,
        setFaceFallbackEnabled,
        faceCandidates: buildFaceCandidates,
        refresh: refreshRenderer,
        scheduleRefresh,
        openQuickUi,
        closeQuickUi,
        toggleQuickUi,
        openFullUi,
        installFaceFallback,
        faceHookStatus,
        get originalLoadImage() { return originalLoadImage; }
    };
    Macro.add("bsabeautysetup", {
        handler() {
            const sortSession = createUiSortSession();
            this.output.append(makeTypeSetupUi(sortSession));
        }
    });

    Macro.add("bsabeautyswitcher", {
        handler() { this.output.append(makeManagerUi()); }
    });

    // 組合入口，個別 Macro 仍可單獨使用。
    Macro.add("bsabeautyui", {
        handler() {
            const root = document.createElement("div");
            root.className = "bsa-beauty-ui";
            const sortSession = createUiSortSession();
            root.append(makeManagerUi(), makeTypeSetupUi(sortSession));
            this.output.append(root);
        }
    });

    // 安裝臉部素材回退。
    originalLoadImage = Renderer.ImageLoader.loadImage;
    patchedLoadImage.__bsaBeautySwitcher = true;
    patchedLoadImage.__bsaBeautySwitcherOriginal = originalLoadImage;
    Renderer.ImageLoader.loadImage = patchedLoadImage;

    console.log(TAG, VERSION, "loaded; Face fallback installed");
})();
