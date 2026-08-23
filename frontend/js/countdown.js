let weddingDate = null;
let countdownTimer = null;
let countdownRetryTimer = null;

function updateCountdown() {
    if (!Number.isFinite(weddingDate)) {
        return;
    }

    const now = new Date().getTime();

    const distance = weddingDate - now;

    // Kada odbrojavanje završi
    if (distance <= 0) {
        document.getElementById("countdown-section").innerHTML = `
            <div class="newly-married-message">
                ${t("newly_married")}
            </div>
        `;

        return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));

    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));

    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    document.getElementById("days").textContent = String(days).padStart(2, "0");

    document.getElementById("hours").textContent = String(hours).padStart(2, "0");

    document.getElementById("minutes").textContent = String(minutes).padStart(2, "0");

    document.getElementById("seconds").textContent = String(seconds).padStart(2, "0");
}

async function initializeCountdown() {
    try {
        const config = await window.weddingEventConfig.load();
        weddingDate = config.weddingTimestamp;
        const countdownStatus = document.getElementById("countdown-status");
        const countdownWrapper = document.querySelector(".countdown-wrapper");
        if (countdownStatus) countdownStatus.hidden = true;
        if (countdownWrapper) countdownWrapper.hidden = false;
        updateCountdown();

        if (!countdownTimer) {
            countdownTimer = setInterval(updateCountdown, 1000);
        }
    } catch (error) {
        console.error("Vreme venčanja trenutno nije dostupno:", error);
        const countdownStatus = document.getElementById("countdown-status");
        const countdownWrapper = document.querySelector(".countdown-wrapper");
        document.querySelectorAll('[data-event-date="wedding"]').forEach((element) => {
            element.textContent = t("countdown_unavailable");
            element.classList.add("event-info-unavailable");
        });
        if (countdownStatus) {
            countdownStatus.textContent = t("countdown_unavailable");
            countdownStatus.hidden = false;
        }
        if (countdownWrapper) countdownWrapper.hidden = true;

        if (!countdownRetryTimer) {
            countdownRetryTimer = setTimeout(() => {
                countdownRetryTimer = null;
                initializeCountdown();
            }, 30_000);
        }
    }
}

initializeCountdown();
