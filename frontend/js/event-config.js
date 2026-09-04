(function initializeEventConfig(global) {
    let cachedConfig = null;
    let pendingRequest = null;

    function normalizeConfig(data) {
        const unlockAt = typeof data?.unlockAt === "string" ? data.unlockAt : "";
        const weddingAt = typeof data?.weddingAt === "string" ? data.weddingAt : "";
        const unlockTimestamp = Date.parse(unlockAt);
        const weddingTimestamp = Date.parse(weddingAt);

        if (
            !Number.isFinite(unlockTimestamp) ||
            !Number.isFinite(weddingTimestamp) ||
            unlockTimestamp >= weddingTimestamp
        ) {
            throw new Error("Server je vratio neispravnu konfiguraciju događaja.");
        }

        return {
            unlockAt,
            weddingAt,
            unlockTimestamp,
            weddingTimestamp
        };
    }

    function formatWeddingDate(timestamp) {
        const date = new Date(timestamp);
        const pad = (value) => String(value).padStart(2, "0");
        return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function load(force = false) {
        if (cachedConfig && !force) {
            return cachedConfig;
        }

        if (pendingRequest && !force) {
            return pendingRequest;
        }

        pendingRequest = fetch("/api/event-config", { cache: "no-store" })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Event config API je vratio status ${response.status}.`);
                }

                return normalizeConfig(await response.json());
            })
            .then((config) => {
                cachedConfig = config;
                const formattedWeddingDate = formatWeddingDate(config.weddingTimestamp);
                document.querySelectorAll('[data-event-date="wedding"]').forEach((element) => {
                    element.textContent = formattedWeddingDate;
                    element.classList.remove("event-info-unavailable");
                });
                const copyrightYear = document.getElementById("copyrightYear");
                if (copyrightYear) copyrightYear.textContent = String(new Date().getFullYear());
                return config;
            })
            .finally(() => {
                pendingRequest = null;
            });

        return pendingRequest;
    }

    function isUnlocked() {
        return Boolean(cachedConfig && Date.now() >= cachedConfig.unlockTimestamp);
    }

    global.weddingEventConfig = {
        load,
        isUnlocked,
        formatWeddingDate
    };
})(window);
