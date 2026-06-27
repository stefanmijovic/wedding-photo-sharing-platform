async function loadAdminStats() {
    try {
        const response = await fetch("/api/admin/stats");
        const data = await response.json();

        const stats = data.stats || {};

        document.getElementById("statTotal").textContent = stats.total ?? 0;
        document.getElementById("statApproved").textContent = stats.approved ?? 0;
        document.getElementById("statPending").textContent = stats.pending ?? 0;
        document.getElementById("statHidden").textContent = stats.hidden ?? 0;
        document.getElementById("statDownloads").textContent = stats.downloads ?? 0;

    } catch (error) {
        console.error("Greška pri učitavanju statistike:", error);
    }
}

async function loadAdminPhotos() {
    const gallery = document.getElementById("adminGallery");

    gallery.innerHTML = "<p>Učitavanje...</p>";

    try {
        const response = await fetch("/api/admin/photos");
        const data = await response.json();

        gallery.innerHTML = "";

        if (!data.photos.length) {
            gallery.innerHTML = "<p>Nema uploadovanih fotografija.</p>";
            return;
        }

        data.photos.forEach(photo => {
            const card = document.createElement("div");

            const isPending = photo.status === "pending_review";

            card.className = isPending
                ? "admin-card pending-card"
                : "admin-card";

            let statusClass = "status-hidden";

            if (photo.status === "approved") {
                statusClass = "status-approved";
            }

            if (photo.status === "pending_review") {
                statusClass = "status-pending";
            }

            const aiScore = photo.aiScore ?? 0;

            const aiScoreClass =
                aiScore >= 95
                    ? "ai-score-good"
                    : "ai-score-warning";

            card.innerHTML = `
                <img src="${photo.thumbUrl}" alt="">

                <div class="admin-card-body">
                    <div class="mb-2">
                        Status:
                        <span class="status ${statusClass}">
                            ${photo.status}
                        </span>
                    </div>

                    <div class="mb-2 text-muted small">
                        Preuzimanja: ${photo.downloads ?? 0}
                    </div>

                    <div class="mb-2 small">
                        <strong>AI score:</strong>
                        <span class="${aiScoreClass}">
                            ${aiScore}%
                        </span>
                    </div>

                    <div class="mb-3 small text-muted ai-reason">
                        <strong>AI analiza:</strong><br>
                        ${photo.aiReason || "Nema AI analize"}
                    </div>

                    <div class="d-grid gap-2">
                        <a href="${photo.originalUrl}" target="_blank" class="btn btn-sm btn-secondary">
                            Otvori
                        </a>

                        <button class="btn btn-sm btn-success" onclick="approvePhoto(${photo.id})">
                            Odobri
                        </button>

                        <button class="btn btn-sm btn-warning" onclick="hidePhoto(${photo.id})">
                            Sakrij
                        </button>

                        <button class="btn btn-sm btn-danger" onclick="deletePhoto(${photo.id})">
                            Obriši
                        </button>
                    </div>
                </div>
            `;

            gallery.appendChild(card);
        });

    } catch (error) {
        console.error(error);
        gallery.innerHTML = "<p>Greška pri učitavanju fotografija.</p>";
    }
}

async function refreshAdmin() {
    await loadAdminStats();
    await loadAdminPhotos();
}

async function hidePhoto(id) {
    await fetch(`/api/admin/photos/${id}/hide`, {
        method: "PATCH"
    });

    refreshAdmin();
}

async function approvePhoto(id) {
    await fetch(`/api/admin/photos/${id}/approve`, {
        method: "PATCH"
    });

    refreshAdmin();
}

async function deletePhoto(id) {
    const confirmed = confirm("Da li sigurno želiš da obrišeš ovu fotografiju?");

    if (!confirmed) return;

    await fetch(`/api/admin/photos/${id}`, {
        method: "DELETE"
    });

    refreshAdmin();
}

document.addEventListener("DOMContentLoaded", refreshAdmin);