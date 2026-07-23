// ============================================================
// IMPORTI - eksterne biblioteke i moduli koji se koriste u aplikaciji
// ============================================================
import * as nsfwjs from "nsfwjs";              // Pretrenirani model za detekciju NSFW (neprikladnog) sadržaja na slikama
import * as tf from "@tensorflow/tfjs-node";   // TensorFlow.js (Node.js verzija) - potreban da nsfwjs model može da radi
import fs from "fs";                            // Node.js modul za rad sa fajl sistemom (čitanje slike sa diska)
import sharp from "sharp";                      // Biblioteka za obradu slika (ovde: metadata, resize, grayscale)

// ============================================================
// GLOBALNA PROMENLJIVA ZA MODEL (LAZY LOADING / SINGLETON)
// ============================================================
// Model se učitava samo JEDNOM (pri prvom pozivu), a zatim se
// čuva u memoriji i ponovo koristi za sve naredne slike.
// Ovo je bitno jer je učitavanje AI modela sporo i resursno skupo -
// ne želimo da ga učitavamo iznova za svaku sliku.
let model: nsfwjs.NSFWJS | null = null;

// ============================================================
// PRAGOVI (THRESHOLDS) ZA AI MODERACIJU
// ============================================================
// Ako procenat (0-100) za neku kategoriju pređe ovaj prag,
// slika se šalje na ručni pregled (pending_review) umesto da
// bude automatski odobrena.
const PORN_REVIEW_THRESHOLD = 10;   // Vrlo nizak prag - i najmanja sumnja na eksplicitni sadržaj ide na pregled
const HENTAI_REVIEW_THRESHOLD = 5;  // Još niži prag - hentai kategorija je osetljiva pa se strogo filtrira
const SEXY_REVIEW_THRESHOLD = 85;   // Viši prag jer "Sexy" kategorija hvata i bezazlene slike (kupaći kostimi i sl.)

// ============================================================
// PRAGOVI ZA KVALITET SLIKE (blur i rezolucija)
// ============================================================
const BLUR_REVIEW_THRESHOLD = 50;   // Ako je "oštrina" slike ispod ovog broja, smatra se previše mutnom
const MIN_IMAGE_WIDTH = 800;        // Minimalna dozvoljena širina slike u pikselima
const MIN_IMAGE_HEIGHT = 800;       // Minimalna dozvoljena visina slike u pikselima

/**
 * Učitava NSFW model samo jednom i čuva ga u memoriji (singleton pattern).
 * Svaki naredni poziv vraća već učitani model umesto da ga učitava ponovo.
 */
async function getModel() {
    if (!model) {
        console.log("Učitavam AI moderation model...");
        model = await nsfwjs.load();
        console.log("AI moderation model učitan.");
    }

    return model;
}

/**
 * Računa "blur score" (meru oštrine/zamućenosti) slike koristeći
 * Laplasov operator - standardnu tehniku detekcije ivica u obradi slika.
 * Što je slika oštrija (ima više jasnih ivica), veći je variance (rezultat).
 * Mutne slike imaju male, glatke prelaze pa je variance nizak.
 */
async function getBlurScore(filePath: string) {
    // Priprema sliku: pretvara u crno-belu (greyscale) i smanjuje na širinu 300px
    // radi bržeg izračunavanja (ne treba nam puna rezolucija za ovu proveru)
    const image = sharp(filePath)
        .greyscale()
        .resize({
            width: 300,
            withoutEnlargement: true // Ne uvećava sliku ako je već manja od 300px
        });

    // Izvlači sirove piksele slike kao Buffer, zajedno sa informacijama (širina/visina)
    const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;

    // Ako je slika previše mala da bi se primenio 3x3 Laplasov filter, vraća 0 (nema smisla računati)
    if (width < 3 || height < 3) {
        return 0;
    }

    const values: number[] = [];

    // Prolazi kroz svaki piksel (izuzev ivica slike) i primenjuje Laplasov operator:
    // upoređuje centralni piksel sa 4 suседна (gore, dole, levo, desno)
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = data[y * width + x] ?? 0;
            const top = data[(y - 1) * width + x] ?? 0;
            const bottom = data[(y + 1) * width + x] ?? 0;
            const left = data[y * width + (x - 1)] ?? 0;
            const right = data[y * width + (x + 1)] ?? 0;

            // Laplasova formula: 4*centar - zbir suседних piksela
            // Veliki rezultat znači naglu promenu (ivicu) = oštra slika na tom mestu
            const laplacian = Math.abs(
                (4 * center) - top - bottom - left - right
            );

            values.push(laplacian);
        }
    }

    // Računa prosek (mean) svih Laplasovih vrednosti
    const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length;

    // Računa varijansu (variance) - koliko se vrednosti razlikuju od proseka.
    // Visoka varijansa = puno različitih ivica = oštra slika.
    // Niska varijansa = slika je "ravna"/glatka = verovatno mutna.
    const variance =
        values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;

    return Math.round(variance);
}

/**
 * Glavna funkcija za AI moderaciju slike. Prolazi kroz nekoliko provera
 * redom (rezolucija -> zamućenost -> NSFW sadržaj) i vraća status
 * ("approved" ili "pending_review") zajedno sa ocenom i obrazloženjem.
 */
export async function moderateImage(filePath: string) {
    let imageTensor: tf.Tensor3D | null = null; // TensorFlow tenzor slike - mora se ručno osloboditi iz memorije (dispose)

    try {
        // ------------------------------------------------------
        // PROVERA 1: Minimalna rezolucija slike
        // ------------------------------------------------------
        const metadata = await sharp(filePath).metadata();

        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;

        // Ako je slika premalena (npr. thumbnail poslat kao original), automatski ide na ručni pregled
        if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) {
            return {
                status: "pending_review",
                aiScore: 0,
                aiReason: `Premala rezolucija: ${width}x${height}`
            };
        }

        // ------------------------------------------------------
        // PROVERA 2: Zamućenost (blur) slike
        // ------------------------------------------------------
        const blurScore = await getBlurScore(filePath);

        // Ako je slika previše mutna (loš kvalitet), ide na ručni pregled
        // umesto da se automatski odobri loš snimak
        if (blurScore < BLUR_REVIEW_THRESHOLD) {
            return {
                status: "pending_review",
                aiScore: blurScore,
                aiReason: `Mutna fotografija - blur score: ${blurScore}`
            };
        }

        // ------------------------------------------------------
        // PROVERA 3: NSFW/neprikladan sadržaj (AI klasifikacija)
        // ------------------------------------------------------
        const loadedModel = await getModel(); // Učitava (ili preuzima već učitan) NSFW model

        const imageBuffer = fs.readFileSync(filePath); // Čita sliku sa diska kao sirove bajtove

        // Dekodira sliku u TensorFlow tenzor (3 kanala = RGB, bez alfa kanala)
        // Ovo je format koji nsfwjs model očekuje kao ulaz
        imageTensor = tf.node.decodeImage(imageBuffer, 3) as tf.Tensor3D;

        // Model klasifikuje sliku i vraća niz predikcija sa procentima (verovatnoćama)
        // za svaku kategoriju (npr. Porn, Hentai, Sexy, Neutral, Drawing)
        const predictions: any[] = await loadedModel.classify(imageTensor as any);

        // Izvlači procenat (0-100) za svaku od tri "rizične" kategorije
        const porn =
            Math.round((predictions.find((p: any) => p.className === "Porn")?.probability ?? 0) * 100);

        const hentai =
            Math.round((predictions.find((p: any) => p.className === "Hentai")?.probability ?? 0) * 100);

        const sexy =
            Math.round((predictions.find((p: any) => p.className === "Sexy")?.probability ?? 0) * 100);

        // Pravi čitljiv tekstualni prikaz svih predikcija (za ai_reason kolonu u bazi)
        const reason = predictions
            .map((p: any) => `${p.className}: ${Math.round(p.probability * 100)}%`)
            .join(", ");

        // Ako BILO KOJA od tri kategorije pređe svoj prag, slika ide na ručni pregled
        if (
            porn >= PORN_REVIEW_THRESHOLD ||
            hentai >= HENTAI_REVIEW_THRESHOLD ||
            sexy >= SEXY_REVIEW_THRESHOLD
        ) {
            return {
                status: "pending_review",
                aiScore: Math.max(porn, hentai, sexy), // Uzima najvišu (najsumnjiviju) ocenu kao glavni "aiScore"
                aiReason: `AI review: ${reason}, blur score: ${blurScore}`
            };
        }

        // Ako nijedan prag nije prekoračen, slika se automatski odobrava
        return {
            status: "approved",
            aiScore: Math.max(porn, hentai, sexy),
            aiReason: `AI ok: ${reason}, blur score: ${blurScore}`
        };

    } catch (error) {
        // Ako bilo šta pukne tokom AI moderacije (npr. model ne uspe da učita sliku),
        // slika se šalje na ručni pregled umesto da izazove pad servera
        // ili da se pogrešno automatski odobri
        console.error("AI moderation greška:", error);

        return {
            status: "pending_review",
            aiScore: 0,
            aiReason: "AI moderation failed - ručni pregled potreban"
        };

    } finally {
        // KLJUČNO: TensorFlow tenzori se ne čiste automatski kroz garbage collector
        // kao obični JS objekti - moraju se ručno "dispose"-ovati, inače dolazi do
        // curenja memorije (memory leak) pri obradi velikog broja slika.
        if (imageTensor) {
            imageTensor.dispose();
        }
    }
}
