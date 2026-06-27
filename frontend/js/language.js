function getLanguageFlag(lang) {
    if (lang === "en") return "🇬🇧";
    if (lang === "de") return "🇩🇪";
    return "🇷🇸";
}

function t(key) {
    const lang = localStorage.getItem("wedding_lang") || "sr";

    if (translations[lang] && translations[lang][key]) {
        return translations[lang][key];
    }

    return key;
}

function setLanguage(lang) {
    localStorage.setItem("wedding_lang", lang);
    document.documentElement.lang = lang;

    document.querySelectorAll("[data-i18n]").forEach(element => {
        const key = element.dataset.i18n;

        if (translations[lang] && translations[lang][key]) {
            element.textContent = translations[lang][key];
        }
    });

    const currentFlag = document.getElementById("currentLanguageFlag");
    if (currentFlag) {
        currentFlag.textContent = getLanguageFlag(lang);
    }

    closeLanguageModal();
}

function openLanguageModal() {
    const modal = document.getElementById("languageModal");

    if (modal) {
        modal.style.display = "flex";
    }
}

function closeLanguageModal() {
    const modal = document.getElementById("languageModal");

    if (modal) {
        modal.style.display = "none";
    }
}

function chooseLanguage(lang) {
    setLanguage(lang);
}

document.addEventListener("DOMContentLoaded", () => {
    const savedLanguage = localStorage.getItem("wedding_lang");

    if (savedLanguage) {
        setLanguage(savedLanguage);
    } else {
        openLanguageModal();
    }
});