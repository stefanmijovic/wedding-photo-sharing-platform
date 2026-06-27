// Datum venčanja
const weddingDate = new Date("2026-10-10T13:30:00").getTime();

function updateCountdown() {
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

// odmah pokreni
updateCountdown();

// osvežavanje svake sekunde
setInterval(updateCountdown, 1000);
