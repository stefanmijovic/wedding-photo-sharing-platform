async function readErrorMessage(response) {
    try {
        const data = await response.json();
        return typeof data.error === "string" && data.error
            ? data.error
            : `Operacija nije uspela (HTTP ${response.status}).`;
    } catch {
        return `Operacija nije uspela (HTTP ${response.status}).`;
    }
}

async function adminRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: "include"
    });

    if (response.status === 401) {
        window.location.replace("/login.html");
        throw new Error("Admin sesija je istekla.");
    }

    if (!response.ok) {
        throw new Error(await readErrorMessage(response));
    }

    return response;
}

function showAdminError(error, fallbackMessage) {
    const message = error instanceof Error && error.message
        ? error.message
        : fallbackMessage;

    console.error(fallbackMessage, error);
    window.alert(message);
}

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
}

function getSafePreviewUrl(photo) {
    const candidate =
        photo.mediaType === "video" && photo.webUrl
            ? photo.webUrl
            : photo.originalUrl;

    try {
        const parsed = new URL(candidate, window.location.origin);
        if (
            parsed.origin === window.location.origin &&
            parsed.pathname.startsWith("/uploads/")
        ) {
            return parsed.href;
        }
    } catch {
        // Neispravan URL se ispod zamenjuje bezbednim fallback-om.
    }

    return null;
}

async function checkAdminLogin() {
    try {
        const response = await adminRequest("/api/admin/me");
        return await response.json();
    } catch (error) {
        if (error instanceof Error && error.message === "Admin sesija je istekla.") {
            return null;
        }

        console.error("Greška pri proveri admin sesije:", error);
        window.location.replace("/login.html");
        return null;
    }
}

async function logout() {
    try {
        await adminRequest("/api/admin/logout", {
            method: "POST"
        });
        window.location.replace("/login.html");
    } catch (error) {
        if (!(error instanceof Error && error.message === "Admin sesija je istekla.")) {
            showAdminError(error, "Odjava nije uspela.");
        }
    }
}

async function loadAdminStats() {
    try {
        const response = await adminRequest("/api/admin/stats");
        const data = await response.json();
        const stats = data.stats || {};

        document.getElementById("statTotal").textContent = stats.total ?? 0;
        document.getElementById("statApproved").textContent = stats.approved ?? 0;
        document.getElementById("statPending").textContent = stats.pending ?? 0;
        document.getElementById("statHidden").textContent = stats.hidden ?? 0;
        document.getElementById("statDownloads").textContent = stats.downloads ?? 0;
    } catch (error) {
        if (!(error instanceof Error && error.message === "Admin sesija je istekla.")) {
            showAdminError(error, "Statistika nije mogla da se učita.");
        }
    }
}

function createAdminCard(photo) {
    const card = document.createElement("div");
    const isPending = photo.status === "pending_review";
    card.className = isPending ? "admin-card pending-card" : "admin-card";

    if (photo.thumbUrl) {
        const thumbnail = document.createElement("img");
        thumbnail.src = photo.thumbUrl;
        thumbnail.alt =
            photo.mediaType === "video"
                ? "Thumbnail video snimka"
                : "Thumbnail fotografije";
        thumbnail.loading = "lazy";
        card.appendChild(thumbnail);
    } else {
        const placeholder = createTextElement(
            "div",
            "admin-media-placeholder",
            photo.mediaType === "video"
                ? "Video se obrađuje…"
                : "Pregled nije dostupan"
        );
        placeholder.setAttribute("role", "status");
        card.appendChild(placeholder);
    }

    const body = document.createElement("div");
    body.className = "admin-card-body";

    let statusClass = "status-hidden";
    if (photo.status === "approved") statusClass = "status-approved";
    if (photo.status === "pending_review") statusClass = "status-pending";

    const statusRow = createTextElement("div", "mb-2", "Status: ");
    const status = createTextElement("span", `status ${statusClass}`, photo.status);
    statusRow.appendChild(status);
    body.appendChild(statusRow);

    body.appendChild(
        createTextElement(
            "div",
            "mb-2 text-muted small",
            `Tip: ${photo.mediaType || "image"}`
        )
    );

    if (photo.mediaType === "video") {
        const processingLabels = {
            queued: "Na čekanju",
            processing: "Obrada…",
            completed: "U redu",
            failed: "Neuspešna"
        };
        const processingStatus = photo.processingStatus || "queued";
        const processingRow = createTextElement(
            "div",
            "mb-2 small",
            `Video obrada: ${processingLabels[processingStatus] || processingStatus}`
        );
        body.appendChild(processingRow);

        if (processingStatus === "failed" && photo.processingError) {
            body.appendChild(
                createTextElement("div", "mb-3 small text-danger", photo.processingError)
            );
        }
    }
    body.appendChild(
        createTextElement(
            "div",
            "mb-2 text-muted small",
            `Preuzimanja: ${photo.downloads ?? 0}`
        )
    );

    const aiScore = Number.isFinite(Number(photo.aiScore))
        ? Number(photo.aiScore)
        : 0;
    const aiScoreRow = createTextElement("div", "mb-2 small", "AI score: ");
    const aiScoreClass =
        photo.status === "pending_review"
            ? "ai-score-warning"
            : "ai-score-good";
    aiScoreRow.appendChild(
        createTextElement("span", aiScoreClass, `${aiScore}%`)
    );
    body.appendChild(aiScoreRow);

    const aiReason = document.createElement("div");
    aiReason.className = "mb-3 small text-muted ai-reason";
    aiReason.appendChild(createTextElement("strong", "", "AI analiza:"));
    aiReason.appendChild(document.createElement("br"));
    aiReason.appendChild(
        document.createTextNode(photo.aiReason || "Nema AI analize")
    );
    body.appendChild(aiReason);

    const actions = document.createElement("div");
    actions.className = "d-grid gap-2";

    if (photo.mediaType === "video" && photo.processingStatus === "failed") {
        const retryButton = createTextElement(
            "button",
            "btn btn-sm btn-primary",
            "Ponovi obradu"
        );
        retryButton.type = "button";
        retryButton.addEventListener("click", () => retryVideoProcessing(photo.id));
        actions.appendChild(retryButton);
    }

    const previewUrl = getSafePreviewUrl(photo);
    if (previewUrl) {
        const openLink = createTextElement(
            "a",
            "btn btn-sm btn-secondary",
            "Otvori"
        );
        openLink.href = previewUrl;
        openLink.target = "_blank";
        openLink.rel = "noopener noreferrer";
        actions.appendChild(openLink);
    }

    const approveButton = createTextElement(
        "button",
        "btn btn-sm btn-success",
        "Odobri"
    );
    approveButton.type = "button";
    approveButton.addEventListener("click", () => approvePhoto(photo.id));
    actions.appendChild(approveButton);

    const hideButton = createTextElement(
        "button",
        "btn btn-sm btn-warning",
        "Sakrij"
    );
    hideButton.type = "button";
    hideButton.addEventListener("click", () => hidePhoto(photo.id));
    actions.appendChild(hideButton);

    const deleteButton = createTextElement(
        "button",
        "btn btn-sm btn-danger",
        "Obriši"
    );
    deleteButton.type = "button";
    deleteButton.addEventListener("click", () => deletePhoto(photo.id));
    actions.appendChild(deleteButton);

    body.appendChild(actions);
    card.appendChild(body);
    return card;
}

async function loadAdminPhotos() {
    const gallery = document.getElementById("adminGallery");
    gallery.replaceChildren(
        createTextElement("p", "", "Učitavanje…")
    );

    try {
        const response = await adminRequest("/api/admin/photos");
        const data = await response.json();
        const photos = Array.isArray(data.photos) ? data.photos : [];

        gallery.replaceChildren();

        if (photos.length === 0) {
            gallery.appendChild(
                createTextElement("p", "", "Nema uploadovanih fotografija.")
            );
            return;
        }

        const fragment = document.createDocumentFragment();
        photos.forEach((photo) => fragment.appendChild(createAdminCard(photo)));
        gallery.appendChild(fragment);
    } catch (error) {
        if (!(error instanceof Error && error.message === "Admin sesija je istekla.")) {
            console.error("Greška pri učitavanju medija:", error);
            gallery.replaceChildren(
                createTextElement(
                    "p",
                    "",
                    error instanceof Error
                        ? error.message
                        : "Greška pri učitavanju fotografija."
                )
            );
        }
    }
}

async function refreshAdmin() {
    const user = await checkAdminLogin();
    if (!user) return;
    configureRoleUi(user);

    await Promise.all([loadAdminStats(), loadAdminPhotos()]);
}

async function runPhotoAction(url, options, fallbackMessage) {
    try {
        await adminRequest(url, options);
        await refreshAdmin();
    } catch (error) {
        if (!(error instanceof Error && error.message === "Admin sesija je istekla.")) {
            showAdminError(error, fallbackMessage);
        }
    }
}

async function hidePhoto(id) {
    await runPhotoAction(
        `/api/admin/photos/${id}/hide`,
        { method: "PATCH" },
        "Sakrivanje medija nije uspelo."
    );
}

async function approvePhoto(id) {
    await runPhotoAction(
        `/api/admin/photos/${id}/approve`,
        { method: "PATCH" },
        "Odobravanje medija nije uspelo."
    );
}

async function retryVideoProcessing(id) {
    await runPhotoAction(
        `/api/admin/photos/${id}/retry-processing`,
        { method: "POST" },
        "Ponovno pokretanje video obrade nije uspelo."
    );
}

async function deletePhoto(id) {
    const confirmed = window.confirm(
        "Da li sigurno želiš da obrišeš ovaj medij?"
    );
    if (!confirmed) return;

    await runPhotoAction(
        `/api/admin/photos/${id}`,
        { method: "DELETE" },
        "Brisanje medija nije uspelo."
    );
}

let currentAdminRole = "admin";
let activeAdminSection = "media";
let voiceOffset = 0;
let voiceTotal = 0;
let voiceLoading = false;
const VOICE_PAGE_SIZE = 20;

function configureRoleUi(user) {
    currentAdminRole = user.role === "couple" ? "couple" : "admin";
    const tabs = document.getElementById("adminSectionTabs");
    if (currentAdminRole === "couple") {
        tabs.hidden = false;
    } else {
        tabs.hidden = true;
        showAdminSection("media");
    }
}

function showAdminSection(section) {
    if (section === "voice" && currentAdminRole !== "couple") return;
    activeAdminSection = section;
    const voiceActive = section === "voice";
    document.getElementById("mediaAdminSection").hidden = voiceActive;
    document.getElementById("voiceAdminSection").hidden = !voiceActive;
    document.getElementById("mediaTabButton").classList.toggle("is-active", !voiceActive);
    document.getElementById("voiceTabButton").classList.toggle("is-active", voiceActive);
    if (voiceActive) void refreshVoicePanel();
}

function formatVoiceDuration(value) {
    if (value === null || value === undefined || value === "") return "--:--";
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const rounded = Math.round(seconds);
    return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatVoiceDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("sr-RS", { dateStyle: "medium", timeStyle: "short" }).format(date)
        : "Nepoznat datum";
}

async function loadVoiceStats() {
    const response = await adminRequest("/api/couple/voice-messages/stats");
    const stats = (await response.json()).stats || {};
    document.getElementById("voiceStatTotal").textContent = stats.total ?? 0;
    document.getElementById("voiceStatNew").textContent = stats.new ?? 0;
    document.getElementById("voiceStatReady").textContent = stats.ready ?? 0;
    document.getElementById("voiceStatProcessing").textContent = stats.processing ?? 0;
    document.getElementById("voiceStatFailed").textContent = stats.failed ?? 0;
}

function createVoiceAction(label, className, handler) {
    const button = createTextElement("button", `btn btn-sm ${className}`, label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
}

async function setVoiceListened(message, listened, card) {
    try {
        const response = await adminRequest(`/api/couple/voice-messages/${message.id}/listened`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ listened })
        });
        const result = await response.json();
        message.listenedAt = result.listenedAt;
        card.classList.toggle("is-new", !message.listenedAt);
        const status = card.querySelector(".voice-listened-status");
        if (status) {
            status.className = `voice-listened-status ${message.listenedAt ? "is-listened" : "is-new"}`;
            status.textContent = message.listenedAt ? "✓ Preslušana" : "● Nova";
        }
        const toggle = card.querySelector(".voice-listened-toggle");
        if (toggle) toggle.textContent = message.listenedAt ? "Označi kao novu" : "Označi kao preslušanu";
        await loadVoiceStats();
    } catch (error) {
        console.error("Listened status nije sačuvan:", error);
    }
}

function createVoiceCard(message) {
    const card = document.createElement("article");
    card.className = `voice-message-card${message.processingStatus === "ready" && !message.listenedAt ? " is-new" : ""}`;
    card.dataset.voiceId = String(message.id);
    const content = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "voice-message-heading";
    heading.appendChild(createTextElement("h3", "", message.senderName || "Anonimno"));
    const processingLabel = message.processingStatus === "ready"
        ? "Spremna"
        : message.processingStatus === "failed" ? "Obrada nije uspela" : "Obrada u toku…";
    heading.appendChild(createTextElement("span", `voice-message-status is-${message.processingStatus}`, processingLabel));
    content.appendChild(heading);
    const meta = document.createElement("div");
    meta.className = "voice-message-meta";
    meta.appendChild(createTextElement("span", "", formatVoiceDate(message.createdAt)));
    meta.appendChild(createTextElement("span", "", formatVoiceDuration(message.durationSeconds)));
    if (message.processingStatus === "ready") {
        const listenedLabel = createTextElement(
            "span",
            `voice-listened-status ${message.listenedAt ? "is-listened" : "is-new"}`,
            message.listenedAt ? "✓ Preslušana" : "● Nova"
        );
        meta.appendChild(listenedLabel);
    }
    content.appendChild(meta);
    if (message.processingStatus === "ready") {
        const audio = document.createElement("audio");
        audio.className = "voice-message-player";
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = `/api/couple/voice-messages/${message.id}/stream`;
        let playHandled = Boolean(message.listenedAt);
        audio.addEventListener("play", () => {
            if (!playHandled && !message.listenedAt) {
                playHandled = true;
                void setVoiceListened(message, true, card);
            }
        });
        content.appendChild(audio);
    }
    card.appendChild(content);
    const actions = document.createElement("div");
    actions.className = "voice-message-actions";
    if (message.processingStatus === "ready") {
        const download = createTextElement("a", "btn btn-sm btn-primary", "Preuzmi");
        download.href = `/api/couple/voice-messages/${message.id}/download`;
        actions.appendChild(download);
        const listenedToggle = createVoiceAction(
            message.listenedAt ? "Označi kao novu" : "Označi kao preslušanu",
            "btn-secondary",
            () => setVoiceListened(message, !message.listenedAt, card)
        );
        listenedToggle.classList.add("voice-listened-toggle");
        actions.appendChild(listenedToggle);
    }
    actions.appendChild(createVoiceAction("Obriši", "btn-danger", () => deleteVoiceMessage(message.id, card)));
    card.appendChild(actions);
    return card;
}

async function loadVoiceMessages({ reset = false } = {}) {
    if (voiceLoading || currentAdminRole !== "couple") return;
    voiceLoading = true;
    const list = document.getElementById("voiceMessagesList");
    const loadMore = document.getElementById("voiceLoadMoreButton");
    loadMore.disabled = true;
    if (reset) {
        voiceOffset = 0;
        list.replaceChildren(createTextElement("div", "voice-panel-state", "Učitavanje glasovnih poruka…"));
    }
    try {
        const response = await adminRequest(`/api/couple/voice-messages?limit=${VOICE_PAGE_SIZE}&offset=${voiceOffset}`);
        const data = await response.json();
        const messages = Array.isArray(data.messages) ? data.messages : [];
        voiceTotal = Number(data.pagination?.total) || 0;
        if (reset) list.replaceChildren();
        const fragment = document.createDocumentFragment();
        messages.forEach((message) => fragment.appendChild(createVoiceCard(message)));
        list.appendChild(fragment);
        voiceOffset += messages.length;
        if (voiceOffset === 0) list.appendChild(createTextElement("div", "voice-panel-state", "Još nema glasovnih poruka."));
        loadMore.hidden = voiceOffset >= voiceTotal;
    } catch (error) {
        console.error("Voice lista nije učitana:", error);
        if (reset) list.replaceChildren(createTextElement("div", "voice-panel-state", "Glasovne poruke trenutno nije moguće učitati."));
    } finally {
        voiceLoading = false;
        loadMore.disabled = false;
    }
}

async function refreshVoicePanel() {
    if (currentAdminRole !== "couple") return;
    try {
        await Promise.all([loadVoiceStats(), loadVoiceMessages({ reset: true })]);
    } catch (error) {
        if (!(error instanceof Error && error.message === "Admin sesija je istekla.")) {
            console.error("Voice panel nije osvežen:", error);
        }
    }
}

async function deleteVoiceMessage(id, card) {
    const confirmed = window.confirm("Da li sigurno želite da obrišete ovu glasovnu poruku? Ova radnja se ne može poništiti.");
    if (!confirmed) return;
    try {
        await adminRequest(`/api/couple/voice-messages/${id}`, { method: "DELETE" });
        card.remove();
        voiceOffset = Math.max(0, voiceOffset - 1);
        voiceTotal = Math.max(0, voiceTotal - 1);
        if (!document.querySelector(".voice-message-card")) {
            document.getElementById("voiceMessagesList").appendChild(createTextElement("div", "voice-panel-state", "Još nema glasovnih poruka."));
        }
        await loadVoiceStats();
    } catch (error) {
        showAdminError(error, "Brisanje glasovne poruke nije uspelo.");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("mediaTabButton").addEventListener("click", () => showAdminSection("media"));
    document.getElementById("voiceTabButton").addEventListener("click", () => showAdminSection("voice"));
    document.getElementById("refreshVoiceButton").addEventListener("click", refreshVoicePanel);
    document.getElementById("voiceLoadMoreButton").addEventListener("click", () => loadVoiceMessages());
    void refreshAdmin();
});
