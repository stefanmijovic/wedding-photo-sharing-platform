(function initializeVoiceRecorder() {
    "use strict";

    const VOICE_MAX_DURATION_SECONDS = 120;
    const states = new Set(["closed", "requesting_permission", "ready", "recording", "preview", "uploading", "success", "error"]);
    const elements = {};
    let state = "closed";
    let stream = null;
    let recorder = null;
    let chunks = [];
    let recordingBlob = null;
    let previewUrl = null;
    let timerId = null;
    let recordingStartedAt = 0;
    let statusKey = "";
    let statusKind = "";
    let autoStopped = false;
    let lastFocusedElement = null;
    let xhr = null;

    function translate(key) {
        return typeof window.t === "function" ? window.t(key) : key;
    }

    function setStatus(key, kind = "") {
        statusKey = key;
        statusKind = kind;
        elements.status.textContent = key ? translate(key) : "";
        elements.status.className = `voice-status${kind ? ` is-${kind}` : ""}`;
    }

    function updateTranslatedAttributes() {
        document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
            element.placeholder = translate(element.dataset.i18nPlaceholder);
        });
        document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
            element.setAttribute("aria-label", translate(element.dataset.i18nAria));
        });
        if (statusKey) setStatus(statusKey, statusKind);
    }

    function render() {
        if (!states.has(state)) throw new Error(`Nepoznato voice stanje: ${state}`);
        const isClosed = state === "closed";
        elements.modal.hidden = isClosed;
        elements.modal.setAttribute("aria-hidden", String(isClosed));
        elements.initialFields.hidden = !["ready", "requesting_permission", "error"].includes(state);
        elements.recordingPanel.hidden = state !== "recording";
        elements.previewPanel.hidden = !["preview", "uploading"].includes(state);
        elements.progress.hidden = state !== "uploading";
        elements.start.hidden = !["ready", "error"].includes(state);
        elements.stop.hidden = state !== "recording";
        elements.rerecord.hidden = !["preview", "error"].includes(state);
        elements.send.hidden = !["preview", "uploading"].includes(state);
        elements.successClose.hidden = state !== "success";
        elements.close.disabled = state === "uploading";
        elements.start.disabled = state === "requesting_permission";
        elements.rerecord.disabled = state === "uploading";
        elements.send.disabled = state === "uploading";
        if (!isClosed) document.body.classList.add("voice-modal-open");
        else document.body.classList.remove("voice-modal-open");
    }

    function setState(nextState, nextStatusKey = "", kind = "") {
        state = nextState;
        render();
        setStatus(nextStatusKey, kind);
    }

    function stopTracks() {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        stream = null;
    }

    function clearTimer() {
        if (timerId) clearInterval(timerId);
        timerId = null;
    }

    function clearRecording() {
        clearTimer();
        stopTracks();
        recorder = null;
        chunks = [];
        recordingBlob = null;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
        elements.preview.removeAttribute("src");
        elements.preview.load();
        elements.timer.textContent = "00:00 / 02:00";
        autoStopped = false;
    }

    function formatTime(seconds) {
        const safe = Math.max(0, Math.min(VOICE_MAX_DURATION_SECONDS, Math.floor(seconds)));
        return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
    }

    function updateTimer() {
        const elapsed = (Date.now() - recordingStartedAt) / 1000;
        elements.timer.textContent = `${formatTime(elapsed)} / 02:00`;
        if (elapsed >= VOICE_MAX_DURATION_SECONDS) {
            autoStopped = true;
            stopRecording();
        }
    }

    function selectMimeType() {
        const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
        if (typeof MediaRecorder.isTypeSupported !== "function") return "";
        return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
    }

    function permissionMessage(error) {
        if (["NotAllowedError", "SecurityError"].includes(error?.name)) return "voice_permission_denied";
        if (error?.name === "NotFoundError") return "voice_microphone_not_found";
        if (["NotReadableError", "AbortError"].includes(error?.name)) return "voice_microphone_busy";
        return "voice_recording_error";
    }

    async function startRecording() {
        if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== "function") {
            setState("error", "voice_browser_unsupported", "error");
            return;
        }
        clearRecording();
        setState("requesting_permission", "voice_requesting_permission");
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (state === "closed") { stopTracks(); return; }
            const mimeType = selectMimeType();
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            chunks = [];
            recorder.addEventListener("dataavailable", (event) => {
                if (event.data?.size) chunks.push(event.data);
            });
            recorder.addEventListener("error", (event) => {
                console.error("MediaRecorder greška:", event.error?.name || "unknown");
                stopTracks();
                setState("error", "voice_recording_error", "error");
            });
            recorder.addEventListener("stop", () => {
                clearTimer();
                stopTracks();
                if (state === "closed" || state === "error") { chunks = []; recorder = null; return; }
                const blobType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
                recordingBlob = new Blob(chunks, { type: blobType });
                chunks = [];
                recorder = null;
                if (!recordingBlob.size) {
                    setState("error", "voice_recording_error", "error");
                    return;
                }
                previewUrl = URL.createObjectURL(recordingBlob);
                elements.preview.src = previewUrl;
                setState("preview", autoStopped ? "voice_max_duration_reached" : "");
            }, { once: true });
            recorder.start(250);
            recordingStartedAt = Date.now();
            setState("recording");
            updateTimer();
            timerId = setInterval(updateTimer, 250);
        } catch (error) {
            console.error("Mikrofon nije dostupan:", error?.name || "unknown");
            stopTracks();
            setState("error", permissionMessage(error), "error");
        }
    }

    function stopRecording() {
        clearTimer();
        if (recorder && recorder.state !== "inactive") recorder.stop();
        stopTracks();
    }

    function rerecord() {
        clearRecording();
        setState("ready", "voice_max_duration");
        elements.start.focus();
    }

    function uploadErrorKey(status, body) {
        if (body?.code === "EVENT_LOCKED") return "voice_locked_message";
        if (status === 413) return "voice_file_too_large";
        if (status === 400 || status === 415 || status === 422) return "voice_invalid_audio";
        if (status === 429) return "voice_rate_limited";
        return "voice_upload_error";
    }

    function sendRecording() {
        if (!recordingBlob || state !== "preview") return;
        const form = new FormData();
        const type = recordingBlob.type || "audio/webm";
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        form.append("voice", recordingBlob, `voice-message.${extension}`);
        const senderName = elements.sender.value.trim();
        if (senderName) form.append("sender_name", senderName);
        xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/voice-messages");
        xhr.responseType = "json";
        xhr.upload.addEventListener("progress", (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
            elements.progressBar.style.width = `${percent}%`;
            elements.progressText.textContent = `${percent}%`;
        });
        xhr.addEventListener("load", (event) => {
            const request = event.currentTarget;
            const response = request.response;
            xhr = null;
            if (xhr === null && state === "closed") return;
            if (request.status === 202 && response?.success) {
                clearRecording();
                elements.sender.value = "";
                updateCounter();
                setState("success", "voice_success", "success");
                elements.successClose.focus();
                return;
            }
            const key = uploadErrorKey(request.status, response);
            if ([400, 413, 415, 422].includes(request.status)) setState("error", key, "error");
            else setState("preview", key, "error");
        });
        xhr.addEventListener("error", () => { xhr = null; setState("preview", "voice_network_error", "error"); });
        xhr.addEventListener("abort", () => { xhr = null; if (state !== "closed") setState("preview", "voice_network_error", "error"); });
        elements.progressBar.style.width = "0";
        elements.progressText.textContent = "0%";
        setState("uploading", "voice_uploading");
        xhr.send(form);
    }

    async function openModal() {
        lastFocusedElement = document.activeElement;
        try {
            await window.weddingEventConfig.load();
            if (!window.weddingEventConfig.isUnlocked()) {
                if (typeof window.showInfoPopup === "function") window.showInfoPopup(translate("voice_locked_title"), translate("voice_locked_message"));
                return;
            }
        } catch (error) {
            console.error("Voice event config nije dostupan:", error);
            if (typeof window.showInfoPopup === "function") window.showInfoPopup(translate("voice_locked_title"), translate("voice_upload_error"));
            return;
        }
        clearRecording();
        setState("ready", "voice_max_duration");
        updateTranslatedAttributes();
        requestAnimationFrame(() => elements.card.focus());
    }

    function closeModal() {
        if (state === "uploading") return;
        if (recorder && recorder.state !== "inactive") recorder.stop();
        clearRecording();
        setState("closed");
        if (lastFocusedElement?.focus) lastFocusedElement.focus();
    }

    function updateCounter() {
        elements.counter.textContent = `${[...elements.sender.value].length} / 60`;
    }

    function handleModalKeydown(event) {
        if (event.key === "Escape" && state !== "uploading") { event.preventDefault(); closeModal(); return; }
        if (event.key !== "Tab") return;
        const focusable = [...elements.card.querySelectorAll("button:not([hidden]):not(:disabled), input:not([hidden]), audio[controls]")];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    document.addEventListener("DOMContentLoaded", () => {
        Object.assign(elements, {
            modal: document.getElementById("voiceModal"), card: document.querySelector(".voice-modal-card"), close: document.getElementById("voiceModalClose"),
            initialFields: document.getElementById("voiceInitialFields"), sender: document.getElementById("voiceSenderName"), counter: document.getElementById("voiceSenderCounter"),
            status: document.getElementById("voiceStatus"), recordingPanel: document.getElementById("voiceRecordingPanel"), timer: document.getElementById("voiceTimer"),
            previewPanel: document.getElementById("voicePreviewPanel"), preview: document.getElementById("voicePreview"), progress: document.getElementById("voiceUploadProgress"),
            progressBar: document.getElementById("voiceProgressBar"), progressText: document.getElementById("voiceProgressText"), start: document.getElementById("voiceStartButton"),
            stop: document.getElementById("voiceStopButton"), rerecord: document.getElementById("voiceRerecordButton"), send: document.getElementById("voiceSendButton"),
            successClose: document.getElementById("voiceSuccessClose"), trigger: document.getElementById("voiceMessageButton")
        });
        elements.trigger.addEventListener("click", openModal);
        elements.close.addEventListener("click", closeModal);
        elements.successClose.addEventListener("click", closeModal);
        elements.start.addEventListener("click", startRecording);
        elements.stop.addEventListener("click", stopRecording);
        elements.rerecord.addEventListener("click", rerecord);
        elements.send.addEventListener("click", sendRecording);
        elements.sender.addEventListener("input", updateCounter);
        elements.preview.addEventListener("error", () => setState("error", "voice_preview_error", "error"));
        elements.modal.addEventListener("click", (event) => { if (event.target === elements.modal) closeModal(); });
        elements.card.addEventListener("keydown", handleModalKeydown);
        window.addEventListener("wedding:language-changed", updateTranslatedAttributes);
        render();
        updateCounter();
        updateTranslatedAttributes();
    });
})();
