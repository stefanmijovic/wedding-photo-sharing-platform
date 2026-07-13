const loginForm = document.getElementById("loginForm");
const errorBox = document.getElementById("error");

document.getElementById("username").focus();

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    errorBox.textContent = "";

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
        const response = await fetch("/api/admin/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include",
            body: JSON.stringify({
                username,
                password
            })
        });

        let data = {};

        try {
            data = await response.json();
        } catch {
            data = {};
        }

        if (!response.ok) {
            errorBox.textContent = data.error || "Pogrešno korisničko ime ili lozinka.";

            return;
        }

        window.location.href = "/admin.html";
    } catch (error) {
        console.error(error);

        errorBox.textContent = "Greška u komunikaciji sa serverom.";
    }
});
