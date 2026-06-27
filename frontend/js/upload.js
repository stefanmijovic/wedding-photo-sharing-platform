let lightboxInstance = null;
let photoDownloadMap = new Map();
let photoLikeMap = new Map();

let clientId = localStorage.getItem("wedding_client_id");

if (!clientId) {
    clientId = "client-" + Date.now() + "-" + Math.random().toString(36).substring(2, 12);

    localStorage.setItem("wedding_client_id", clientId);
}

let currentPage = 1;
let hasMorePhotos = true;
let isLoadingPhotos = false;
const PHOTOS_PER_PAGE = 50;

const unlockDate = new Date("2026-10-09T23:00:00").getTime();

function isUnlocked() {
    return new Date().getTime() >= unlockDate;
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

function openGallerySection(event) {
    if (event) {
        event.preventDefault();
    }

    if (!isUnlocked()) {
        showInfoPopup(t("gallery_locked_title"), t("gallery_locked_message"));

        return;
    }

    document.getElementById("weddingGallery").scrollIntoView({ behavior: "smooth" });
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
    const likeData = photoLikeMap.get(mediaUrl);

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
    const downloadUrl = photoDownloadMap.get(mediaUrl);

    if (!downloadUrl) return;

    const btn = createDownloadButton();

    btn.href = downloadUrl;
    btn.setAttribute("download", "");
}

function rebuildLightbox() {
    if (lightboxInstance) {
        lightboxInstance.destroy();
        removeLightboxDownloadButton();
        removeLightboxLikeButton();
    }

    lightboxInstance = GLightbox({
        selector: '[data-glightbox="wedding-gallery"]',
        touchNavigation: true,
        loop: true,
        closeOnOutsideClick: true
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

        photoDownloadMap.set(absoluteOriginalUrl, absoluteDownloadUrl);
        photoLikeMap.set(absoluteOriginalUrl, {
            id: photo.id,
            likes: photo.likes ?? 0
        });

        if (isVideo && photo.webUrl) {
            const absoluteWebUrl = new URL(photo.webUrl, window.location.origin).href;

            photoDownloadMap.set(absoluteWebUrl, absoluteDownloadUrl);

            photoLikeMap.set(absoluteWebUrl, {
                id: photo.id,
                likes: photo.likes ?? 0
            });
        }

        a.addEventListener("click", () => {
            setTimeout(updateDownloadButtonFromCurrentSlide, 300);
        });

        const img = document.createElement("img");
        img.src = photo.thumbUrl;
        img.alt = "";
        img.loading = "lazy";

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

        likeBadge.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();

            try {
                const likes = await likePhoto(photo.id);
                likeBadge.textContent = `❤️ ${likes}`;
                likeBadge.classList.add("liked");
            } catch (error) {
                console.error(error);
            }
        });

        wrapper.appendChild(likeBadge);

        grid.appendChild(wrapper);
    });

    rebuildLightbox();
}

async function loadGallery(reset = true) {
    if (isLoadingPhotos) return;

    try {
        isLoadingPhotos = true;

        const grid = document.querySelector(".photo-grid");
        if (!grid) return;

        if (reset) {
            currentPage = 1;
            hasMorePhotos = true;
            photoDownloadMap = new Map();
            photoLikeMap = new Map();
            grid.innerHTML = "";
            removeLightboxDownloadButton();
        }

        if (!hasMorePhotos) return;

        const response = await fetch(`/api/photos?page=${currentPage}&limit=${PHOTOS_PER_PAGE}`);
        const data = await response.json();

        addPhotosToGrid(data.photos || []);

        hasMorePhotos = Boolean(data.hasMore);
        currentPage++;
    } catch (error) {
        console.error("Greška pri učitavanju galerije:", error);
    } finally {
        isLoadingPhotos = false;
    }
}

function setupInfiniteScroll() {
    window.addEventListener("scroll", () => {
        if (!hasMorePhotos || isLoadingPhotos) return;

        const scrollPosition = window.innerHeight + window.scrollY;
        const pageHeight = document.documentElement.scrollHeight;

        if (scrollPosition >= pageHeight - 600) {
            loadGallery(false);
        }
    });
}

function uploadSingleFile(file, index, total) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();

        formData.append("photo", file);

        xhr.open("POST", "/api/upload");

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

            reject(new Error(t("upload_failed")));
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
    if (!isUnlocked()) {
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
            }
        }

        showUploadStatus(t("upload_refresh_gallery"));
        await loadGallery(true);

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
    loadGallery(true);
    setupInfiniteScroll();
});
