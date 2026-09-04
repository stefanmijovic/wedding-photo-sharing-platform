let lightboxInstance = null;
let glightboxAssetsPromise = null;
let photoMediaMap = new Map();
let galleryPaginationObserver = null;

function loadStylesheetOnce(id, href) {
    const existingStylesheet = document.getElementById(id);

    if (existingStylesheet) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const link = document.createElement("link");

        link.id = id;
        link.rel = "stylesheet";
        link.href = href;

        link.onload = () => resolve();
        link.onerror = () => {
            link.remove();
            reject(new Error(`CSS nije mogao da se učita: ${href}`));
        };

        document.head.appendChild(link);
    });
}

function loadScriptOnce(id, src) {
    if (typeof GLightbox === "function") {
        return Promise.resolve();
    }

    const existingScript = document.getElementById(id);

    if (existingScript) {
        return new Promise((resolve, reject) => {
            existingScript.addEventListener("load", resolve, { once: true });
            existingScript.addEventListener(
                "error",
                () => reject(new Error(`JavaScript nije mogao da se učita: ${src}`)),
                { once: true }
            );
        });
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement("script");

        script.id = id;
        script.src = src;
        script.async = true;

        script.onload = () => resolve();

        script.onerror = () => {
            script.remove();
            reject(new Error(`JavaScript nije mogao da se učita: ${src}`));
        };

        document.body.appendChild(script);
    });
}

async function ensureGLightboxAssetsLoaded() {
    if (typeof GLightbox === "function") {
        return;
    }

    if (!glightboxAssetsPromise) {
        glightboxAssetsPromise = Promise.all([
            loadStylesheetOnce("glightbox-dynamic-css", "/lib/glightbox/glightbox.min.css?v=3.3.1"),
            loadScriptOnce("glightbox-dynamic-js", "/lib/glightbox/glightbox.min.js?v=3.3.1")
        ]).catch((error) => {
            glightboxAssetsPromise = null;
            throw error;
        });
    }

    await glightboxAssetsPromise;

    if (typeof GLightbox !== "function") {
        glightboxAssetsPromise = null;
        throw new Error("GLightbox biblioteka nije dostupna nakon učitavanja.");
    }
}

let clientId = localStorage.getItem("wedding_client_id");

if (!clientId) {
    clientId = "client-" + Date.now() + "-" + Math.random().toString(36).substring(2, 12);

    localStorage.setItem("wedding_client_id", clientId);
}

let currentPage = 1;
let hasMorePhotos = true;
let isLoadingPhotos = false;
let galleryInitialized = false;
const PHOTOS_PER_PAGE = 50;

async function isUnlocked() {
    try {
        await window.weddingEventConfig.load();
        return window.weddingEventConfig.isUnlocked();
    } catch (error) {
        console.error("Vreme otključavanja trenutno nije dostupno:", error);
        return false;
    }
}

function showInfoPopup(title, message) {
    let popup = document.getElementById("infoPopupBox");

    if (!popup) {
        popup = document.createElement("div");
        popup.id = "infoPopupBox";
        popup.innerHTML = `
            <div class="info-popup-card">
                <h3 id="infoPopupTitle"></h3>
                <p id="infoPopupMessage"></p>
                <button id="infoPopupOk" type="button"></button>
            </div>
        `;

        document.body.appendChild(popup);

        document.getElementById("infoPopupOk").addEventListener("click", () => {
            popup.style.display = "none";
        });
    }

    document.getElementById("infoPopupTitle").textContent = title;
    document.getElementById("infoPopupMessage").textContent = message;
    document.getElementById("infoPopupOk").textContent = t("popup_ok");

    popup.style.display = "flex";
}

async function openGallerySection(event) {
    if (event) {
        event.preventDefault();
    }

    if (!(await isUnlocked())) {
        showInfoPopup(t("gallery_locked_title"), t("gallery_locked_message"));
        return;
    }

    const gallerySection = document.getElementById("weddingGallery");

    if (!gallerySection) {
        return;
    }

    gallerySection.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });

    try {
        await ensureGalleryLoaded();
    } catch (error) {
        console.error("Galerija nije mogla da se učita:", error);
    }
}

function showUploadStatus(message) {
    let box = document.getElementById("uploadStatusBox");

    if (!box) {
        box = document.createElement("div");
        box.id = "uploadStatusBox";
        box.innerHTML = `
            <div class="upload-status-card">
                <div id="uploadStatusText">${t("upload_preparing")}</div>
                <div class="upload-progress">
                    <div id="uploadProgressBar"></div>
                </div>
            </div>
        `;
        document.body.appendChild(box);
    }

    document.getElementById("uploadStatusText").textContent = message;
    box.style.display = "flex";
}

function updateUploadProgress(percent) {
    const bar = document.getElementById("uploadProgressBar");

    if (bar) {
        bar.style.width = percent + "%";
    }
}

function hideUploadStatus() {
    const box = document.getElementById("uploadStatusBox");

    if (box) {
        setTimeout(() => {
            box.style.display = "none";
            updateUploadProgress(0);
        }, 1200);
    }
}

function removeLightboxDownloadButton() {
    const btn = document.getElementById("lightboxDownloadBtn");

    if (btn) {
        btn.remove();
    }
}
function removeLightboxLikeButton() {
    const btn = document.getElementById("lightboxLikeBtn");

    if (btn) {
        btn.remove();
    }
}

function createLightboxLikeButton() {
    let btn = document.getElementById("lightboxLikeBtn");

    if (!btn) {
        btn = document.createElement("button");
        btn.id = "lightboxLikeBtn";
        btn.type = "button";

        btn.style.position = "fixed";
        btn.style.right = "55px";
        btn.style.bottom = "45px";
        btn.style.zIndex = "999999";
        btn.style.background = "rgba(0, 0, 0, 0.78)";
        btn.style.color = "#ffffff";
        btn.style.border = "none";
        btn.style.padding = "12px 18px";
        btn.style.borderRadius = "999px";
        btn.style.fontSize = "22px";
        btn.style.fontWeight = "700";
        btn.style.cursor = "pointer";
        btn.style.backdropFilter = "blur(6px)";

        document.body.appendChild(btn);
    }

    return btn;
}

function updateLightboxLikeButtonFromCurrentSlide() {
    const activeMedia = document.querySelector(".gslide.current img, .gslide.current video");

    if (!activeMedia) return;

    const mediaUrl = new URL(activeMedia.currentSrc || activeMedia.src, window.location.origin).href;
    const likeData = photoMediaMap.get(mediaUrl);

    if (!likeData) return;

    const btn = createLightboxLikeButton();

    btn.textContent = `❤️ ${likeData.likes ?? 0}`;

    btn.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();

        try {
            const likes = await likePhoto(likeData.id);

            btn.textContent = `❤️ ${likes}`;
            likeData.likes = likes;

            document.querySelectorAll(`[data-like-photo-id="${likeData.id}"]`).forEach((badge) => {
                badge.textContent = `❤️ ${likes}`;
                badge.classList.add("liked");
            });
        } catch (error) {
            console.error(error);
        }
    };
}

function createDownloadButton() {
    let btn = document.getElementById("lightboxDownloadBtn");

    if (!btn) {
        btn = document.createElement("a");
        btn.id = "lightboxDownloadBtn";
        btn.textContent = t("download_original");

        btn.style.position = "fixed";
        btn.style.top = "20px";
        btn.style.right = "75px";
        btn.style.zIndex = "999999";
        btn.style.background = "rgba(0, 0, 0, 0.78)";
        btn.style.color = "#ffffff";
        btn.style.padding = "10px 14px";
        btn.style.borderRadius = "10px";
        btn.style.fontSize = "14px";
        btn.style.fontWeight = "600";
        btn.style.textDecoration = "none";
        btn.style.lineHeight = "1";
        btn.style.backdropFilter = "blur(6px)";

        document.body.appendChild(btn);
    }

    return btn;
}

function updateDownloadButtonFromCurrentSlide() {
    const activeMedia = document.querySelector(".gslide.current img, .gslide.current video");

    if (!activeMedia) return;

    const mediaUrl = new URL(activeMedia.currentSrc || activeMedia.src, window.location.origin).href;
    const downloadUrl = photoMediaMap.get(mediaUrl)?.downloadUrl;

    if (!downloadUrl) return;

    const btn = createDownloadButton();

    btn.href = downloadUrl;
    btn.setAttribute("download", "");
}

function initializeLightbox() {
    lightboxInstance = GLightbox({
        selector: '[data-glightbox="wedding-gallery"]',
        touchNavigation: true,
        loop: true,
        closeOnOutsideClick: true,

        plyr: {
            css: "/lib/plyr/plyr.css?v=3.8.4",
            js: "/lib/plyr/plyr.polyfilled.js?v=3.8.4",

            config: {
                iconUrl: "/lib/plyr/plyr.svg",

                controls: ["play-large", "play", "progress", "current-time", "mute", "volume", "fullscreen"],

                autoplay: false,
                muted: false,
                clickToPlay: true,
                hideControls: true,
                resetOnEnd: false,

                keyboard: {
                    focused: true,
                    global: false
                }
            }
        }
    });

    lightboxInstance.on("open", () => {
        setTimeout(() => {
            updateDownloadButtonFromCurrentSlide();
            updateLightboxLikeButtonFromCurrentSlide();
        }, 300);
    });

    lightboxInstance.on("slide_changed", () => {
        setTimeout(() => {
            updateDownloadButtonFromCurrentSlide();
            updateLightboxLikeButtonFromCurrentSlide();
        }, 300);
    });

    lightboxInstance.on("close", () => {
        removeLightboxDownloadButton();
        removeLightboxLikeButton();
    });
}

function refreshLightboxElements() {
    if (!lightboxInstance) {
        initializeLightbox();
        return;
    }

    // GLightbox 3.3.1 reload() ponovo skenira selector i zadržava istu
    // instancu/API event registracije. Ne radi destroy/recreate celog lightbox-a.
    lightboxInstance.reload();
}
async function likePhoto(photoId) {
    const response = await fetch(`/api/photos/${photoId}/like`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            clientId
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Like failed");
    }

    return data.likes;
}

function addPhotosToGrid(photos) {
    const grid = document.querySelector(".photo-grid");
    if (!grid) return;
    const fragment = document.createDocumentFragment();

    photos.forEach((photo) => {
        const isVideo = photo.mediaType === "video";

        const wrapper = document.createElement("div");
        wrapper.className = isVideo ? "gallery-item video-item" : "gallery-item";

        const a = document.createElement("a");

        a.href = isVideo && photo.webUrl ? photo.webUrl : photo.originalUrl;

        a.setAttribute("data-glightbox", "wedding-gallery");

        if (isVideo) {
            a.setAttribute("data-type", "video");
        }

        const absoluteOriginalUrl = new URL(photo.originalUrl, window.location.origin).href;
        const absoluteDownloadUrl = new URL(`/api/photos/${photo.id}/download`, window.location.origin).href;

        const mediaData = {
            id: photo.id,
            likes: photo.likes ?? 0,
            downloadUrl: absoluteDownloadUrl
        };
        photoMediaMap.set(absoluteOriginalUrl, mediaData);

        if (isVideo && photo.webUrl) {
            const absoluteWebUrl = new URL(photo.webUrl, window.location.origin).href;

            photoMediaMap.set(absoluteWebUrl, mediaData);
        }

        const img = document.createElement("img");
        img.src = photo.thumbUrl;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.width = 400;
        img.height = 400;

        img.onerror = () => {
            wrapper.remove();
        };

        a.appendChild(img);
        wrapper.appendChild(a);

        if (isVideo) {
            const playBadge = document.createElement("div");
            playBadge.className = "video-play-badge";
            playBadge.textContent = "▶";
            wrapper.appendChild(playBadge);
        }

        const likeBadge = document.createElement("button");
        likeBadge.type = "button";
        likeBadge.className = "photo-like-badge";
        likeBadge.textContent = `❤️ ${photo.likes ?? 0}`;
        likeBadge.dataset.likePhotoId = String(photo.id);

        wrapper.appendChild(likeBadge);

        fragment.appendChild(wrapper);
    });

    grid.appendChild(fragment);
    refreshLightboxElements();
}

function setupGalleryDelegation() {
    const grid = document.querySelector(".photo-grid");
    if (!grid || grid.dataset.actionsDelegated === "true") return;

    grid.dataset.actionsDelegated = "true";
    grid.addEventListener("click", async (event) => {
        const likeBadge = event.target.closest?.(".photo-like-badge");
        if (!likeBadge || !grid.contains(likeBadge)) return;

        event.preventDefault();
        event.stopPropagation();
        if (likeBadge.disabled) return;

        const photoId = Number(likeBadge.dataset.likePhotoId);
        if (!Number.isSafeInteger(photoId) || photoId <= 0) return;

        likeBadge.disabled = true;
        try {
            const likes = await likePhoto(photoId);
            document.querySelectorAll(`[data-like-photo-id="${photoId}"]`).forEach((badge) => {
                badge.textContent = `❤️ ${likes}`;
                badge.classList.add("liked");
            });
            const mediaTrigger = likeBadge.closest(".gallery-item")?.querySelector('[data-glightbox="wedding-gallery"]');
            const mediaData = mediaTrigger
                ? photoMediaMap.get(new URL(mediaTrigger.href, window.location.origin).href)
                : null;
            if (mediaData) mediaData.likes = likes;
        } catch (error) {
            console.error(error);
        } finally {
            likeBadge.disabled = false;
        }
    });
}

async function loadGallery(reset = true) {
    if (isLoadingPhotos) {
        return;
    }

    try {
        isLoadingPhotos = true;

        await ensureGLightboxAssetsLoaded();

        const grid = document.querySelector(".photo-grid");

        if (!grid) {
            throw new Error("Element .photo-grid nije pronađen.");
        }

        if (reset) {
            currentPage = 1;
            hasMorePhotos = true;
            photoMediaMap = new Map();
            grid.innerHTML = "";
            removeLightboxDownloadButton();
            removeLightboxLikeButton();

            if (lightboxInstance) {
                lightboxInstance.destroy();
                lightboxInstance = null;
            }
        }

        if (!hasMorePhotos) {
            return;
        }

        const response = await fetch(`/api/photos?page=${currentPage}&limit=${PHOTOS_PER_PAGE}`);

        if (!response.ok) {
            throw new Error(`API je vratio status ${response.status}`);
        }

        const data = await response.json();

        addPhotosToGrid(data.photos || []);

        hasMorePhotos = Boolean(data.hasMore);
        currentPage++;
    } catch (error) {
        console.error("Greška pri učitavanju galerije:", error);
        throw error;
    } finally {
        isLoadingPhotos = false;
    }
}

async function ensureGalleryLoaded() {
    if (galleryInitialized) {
        return;
    }

    galleryInitialized = true;

    try {
        await loadGallery(true);
    } catch (error) {
        galleryInitialized = false;
        throw error;
    }
}

function setupInfiniteScroll() {
    const sentinel = document.getElementById("galleryLoadSentinel");
    if (!sentinel) return;

    const requestNextPage = () => {
        if (!galleryInitialized || !hasMorePhotos || isLoadingPhotos) return;
        loadGallery(false).catch((error) => console.error("Sledeća gallery stranica nije učitana:", error));
    };

    if ("IntersectionObserver" in window) {
        galleryPaginationObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) requestNextPage();
            },
            { rootMargin: "800px 0px" }
        );
        galleryPaginationObserver.observe(sentinel);
        return;
    }

    // Fallback za stare browsere: jedan layout read po animation frame-u.
    let scheduled = false;
    window.addEventListener("scroll", () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            if (sentinel.getBoundingClientRect().top <= window.innerHeight + 800) requestNextPage();
        });
    }, { passive: true });
}

function setupGalleryObserver() {
    const gallerySection = document.getElementById("weddingGallery");

    if (!gallerySection) {
        return;
    }

    if (!("IntersectionObserver" in window)) {
        return;
    }

    const observer = new IntersectionObserver(
        async (entries) => {
            const galleryIsNear = entries.some((entry) => entry.isIntersecting);

            if (!galleryIsNear || galleryInitialized || !(await isUnlocked())) {
                return;
            }

            try {
                await ensureGalleryLoaded();
                observer.disconnect();
            } catch (error) {
                console.error("Galerija nije mogla da se učita:", error);
            }
        },
        {
            rootMargin: "800px 0px"
        }
    );

    observer.observe(gallerySection);
}

const IMAGE_UPLOAD_LIMIT = 30 * 1024 * 1024;
const VIDEO_UPLOAD_LIMIT = 1024 * 1024 * 1024;
const VIDEO_UPLOAD_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

function classifyUpload(file) {
    const dotIndex = file.name.lastIndexOf(".");
    const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : "";
    const isVideo = file.type.startsWith("video/") || VIDEO_UPLOAD_EXTENSIONS.has(extension);
    return isVideo ? "video" : "image";
}

function uploadSingleFile(file, index, total) {
    return new Promise((resolve, reject) => {
        const category = classifyUpload(file);
        const sizeLimit = category === "video" ? VIDEO_UPLOAD_LIMIT : IMAGE_UPLOAD_LIMIT;
        if (file.size > sizeLimit) {
            const error = new Error(category === "video" ? t("upload_video_too_large") : t("upload_image_too_large"));
            error.code = category === "video" ? "VIDEO_TOO_LARGE" : "IMAGE_TOO_LARGE";
            reject(error);
            return;
        }

        const xhr = new XMLHttpRequest();
        const formData = new FormData();

        formData.append("photo", file);

        xhr.open("POST", category === "video" ? "/api/upload/video" : "/api/upload/image");

        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;

            const filePercent = Math.round((event.loaded / event.total) * 100);

            showUploadStatus(`${t("upload_sending")} ${index + 1}/${total}: ${file.name} (${filePercent}%)`);

            updateUploadProgress(filePercent);
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                updateUploadProgress(100);
                resolve();
                return;
            }

            let responseBody = {};

            try {
                responseBody = JSON.parse(xhr.responseText || "{}");
            } catch {
                responseBody = {};
            }

            const capacityCodes = new Set([
                "CAPACITY_TEMPORARILY_UNAVAILABLE",
                "LOW_DISK_SPACE",
                "IMAGE_PIPELINE_BUSY",
                "VIDEO_QUEUE_BUSY",
                "VOICE_PIPELINE_BUSY"
            ]);
            const error = new Error(
                xhr.status === 503 || capacityCodes.has(responseBody.code)
                    ? t("upload_capacity_busy")
                    : responseBody.error || t("upload_failed")
            );
            error.code = responseBody.code || "UPLOAD_FAILED";
            reject(error);
        };

        xhr.onerror = () => {
            reject(new Error(t("upload_network_error")));
        };

        xhr.onabort = () => {
            reject(new Error(t("upload_aborted")));
        };

        xhr.send(formData);
    });
}

async function openUpload() {
    if (!(await isUnlocked())) {
        showInfoPopup(t("upload_locked_title"), t("upload_locked_message"));

        return;
    }

    const input = document.createElement("input");

    input.type = "file";
    input.accept = "image/*,video/*,.mp4,.mov,.webm";
    input.multiple = true;

    input.onchange = async () => {
        const files = Array.from(input.files);

        if (!files.length) return;

        let successCount = 0;
        let failedCount = 0;

        showUploadStatus(`${t("upload_prepare_files")} ${files.length} ${t("files_word")}...`);
        updateUploadProgress(0);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            try {
                showUploadStatus(`${t("upload_sending")} ${i + 1}/${files.length}: ${file.name} (0%)`);
                updateUploadProgress(0);

                await uploadSingleFile(file, i, files.length);

                successCount++;
            } catch (error) {
                console.error(error);
                failedCount++;

                if (error?.code === "EVENT_LOCKED") {
                    failedCount += files.length - i - 1;
                    showInfoPopup(t("upload_locked_title"), t("upload_locked_message"));
                    break;
                }

                if (error?.code === "IMAGE_TOO_LARGE" || error?.code === "VIDEO_TOO_LARGE") {
                    showInfoPopup(t("upload_failed"), error.message);
                }
            }
        }

        showUploadStatus(t("upload_refresh_gallery"));

        try {
            await loadGallery(true);
            galleryInitialized = true;
        } catch (error) {
            galleryInitialized = false;
            console.error("Galerija nije mogla da se osveži nakon uploada:", error);
        }

        if (failedCount === 0) {
            showUploadStatus(`${t("upload_success")} ${successCount}/${files.length} ${t("files_word")} ❤️`);
        } else {
            showUploadStatus(`${t("upload_sent")}: ${successCount}, ${t("upload_failed_count")}: ${failedCount}`);
        }

        hideUploadStatus();
    };

    input.click();
}

document.addEventListener("DOMContentLoaded", () => {
    setupGalleryDelegation();
    setupInfiniteScroll();
    setupGalleryObserver();
});
