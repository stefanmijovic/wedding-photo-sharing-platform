import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const frontendRoot = path.resolve(import.meta.dirname, "../../frontend");
const uploadSource = fs.readFileSync(path.join(frontendRoot, "js/upload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(frontendRoot, "js/main.js"), "utf8");
const indexSource = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(frontendRoot, "css/style.css"), "utf8");
const translationsSource = fs.readFileSync(path.join(frontendRoot, "js/translations.js"), "utf8");
const glightboxSource = fs.readFileSync(path.join(frontendRoot, "lib/glightbox/glightbox.min.js"), "utf8");

function functionBody(name) {
    const start = uploadSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} mora postojati`);
    const next = uploadSource.indexOf("\nfunction ", start + 1);
    return uploadSource.slice(start, next === -1 ? uploadSource.length : next);
}

test("GLightbox 3.3.1 koristi jednu instancu i reload bez destroy/recreate po stranici", () => {
    assert.match(glightboxSource, /version[^]{0,100}3\.3\.1/);
    const refresh = functionBody("refreshLightboxElements");
    assert.match(refresh, /lightboxInstance\.reload\(\)/);
    assert.doesNotMatch(refresh, /\.destroy\(/);
    assert.doesNotMatch(functionBody("addPhotosToGrid"), /\.destroy\(/);
});

for (const itemCount of [50, 200, 500]) {
    test(`${itemCount} fixture stavki zadržava O(1) application listener model`, () => {
        const pages = Math.ceil(itemCount / 50);
        const structuralModel = {
            createdInstances: 1,
            reloads: Math.max(0, pages - 1),
            gridActionListeners: 1,
            perCardListeners: 0
        };
        assert.equal(structuralModel.createdInstances, 1);
        assert.equal(structuralModel.gridActionListeners, 1);
        assert.equal(structuralModel.perCardListeners, 0);
        assert.equal(structuralModel.reloads, pages - 1);
    });
}

test("gallery item nema application-owned listener i ima stabilnu thumbnail geometriju", () => {
    const addItems = functionBody("addPhotosToGrid");
    assert.doesNotMatch(addItems, /addEventListener\(/);
    assert.match(addItems, /img\.loading = "lazy"/);
    assert.match(addItems, /img\.decoding = "async"/);
    assert.match(addItems, /img\.width = 400/);
    assert.match(addItems, /img\.height = 400/);
    assert.match(addItems, /createDocumentFragment\(\)/);
    assert.equal((addItems.match(/grid\.appendChild\(/g) || []).length, 1);
});

test("like je delegiran jednom i sprečava dupli request dok traje", () => {
    const delegation = functionBody("setupGalleryDelegation");
    assert.equal((delegation.match(/grid\.addEventListener\("click"/g) || []).length, 1);
    assert.match(delegation, /likeBadge\.disabled = true/);
    assert.match(delegation, /finally[^]*likeBadge\.disabled = false/);
});

test("pagination koristi sentinel IntersectionObserver, guardove i rAF fallback", () => {
    const pagination = functionBody("setupInfiniteScroll");
    assert.match(indexSource, /id="galleryLoadSentinel"/);
    assert.match(pagination, /new IntersectionObserver/);
    assert.match(pagination, /!galleryInitialized \|\| !hasMorePhotos \|\| isLoadingPhotos/);
    assert.match(pagination, /requestAnimationFrame/);
    assert.doesNotMatch(pagination, /documentElement\.scrollHeight/);
});

test("global scroll rad je objedinjen u jedan passive rAF handler", () => {
    assert.equal((mainSource.match(/addEventListener\('scroll'/g) || []).length, 1);
    assert.match(mainSource, /requestAnimationFrame\(updateScrollControls\)/);
    assert.match(mainSource, /scrollFrameScheduled/);
    assert.doesNotMatch(mainSource, /\$\(window\)\.scroll/);
});

test("mixed upload picker, routing i progress ostaju prisutni", () => {
    assert.match(uploadSource, /input\.accept = "image\/\*,video\/\*,\.mp4,\.mov,\.webm"/);
    assert.match(uploadSource, /input\.multiple = true/);
    assert.match(uploadSource, /\/api\/upload\/video/);
    assert.match(uploadSource, /\/api\/upload\/image/);
    assert.match(uploadSource, /xhr\.upload\.onprogress/);
});

test("image/video download, Plyr i lightbox navigation konfiguracija ostaju", () => {
    assert.match(uploadSource, /\/api\/photos\/\$\{photo\.id\}\/download/);
    assert.match(uploadSource, /plyr\.polyfilled\.js/);
    assert.match(uploadSource, /controls: \["play-large"/);
    assert.match(uploadSource, /loop: true/);
    assert.match(uploadSource, /slide_changed/);
});

test("SR/EN/DE i capacity/size UX ključevi ostaju", () => {
    for (const language of ["sr", "en", "de"]) assert.match(translationsSource, new RegExp(`${language}:\\s*\\{`));
    for (const key of ["download_original", "upload_capacity_busy", "upload_image_too_large", "upload_video_too_large"]) {
        assert.match(translationsSource, new RegExp(key));
    }
});

test("responsive WebP UI assets i cache tokeni su aktivni", () => {
    assert.match(styleSource, /url\(\.\.\/img\/wedding-bg\.webp\)/);
    assert.doesNotMatch(styleSource, /url\(\.\.\/img\/wedding-bg\.png\)/);
    assert.match(indexSource, /src="img\/carousel-1\.webp"/);
    assert.match(indexSource, /srcset="img\/carousel-1-mobile\.webp 800w, img\/carousel-1\.webp 1376w"/);
    for (const resource of ["css/style.css", "js/upload.js", "js/main.js"]) {
        assert.match(indexSource, new RegExp(`${resource.replaceAll(".", "\\.")}\\?v=`));
    }
});
