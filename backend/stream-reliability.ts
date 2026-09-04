import fs from "node:fs";
import type { Response } from "express";

interface StreamOptions {
    start?: number;
    end?: number;
    createReadStream?: typeof fs.createReadStream;
    operation?: string;
    mediaId?: number;
    basename?: string;
}

export function streamFileToResponse(filePath: string, res: Response, options: StreamOptions = {}): fs.ReadStream {
    const createStream = options.createReadStream ?? fs.createReadStream;
    const range = options.start === undefined ? {} : { start: options.start, ...(options.end === undefined ? {} : { end: options.end }) };
    const stream = createStream(filePath, range);
    stream.once("error", (error: NodeJS.ErrnoException) => {
        console.error(
            `[MEDIA_STREAM_ERROR] operation=${options.operation ?? "stream"}` +
            ` mediaId=${options.mediaId ?? "unknown"} basename=${options.basename ?? "unknown"} code=${error.code ?? error.name}`
        );
        if (!res.headersSent) {
            for (const header of ["Content-Length", "Content-Range", "Accept-Ranges"]) res.removeHeader(header);
            const missing = error.code === "ENOENT";
            res.status(missing ? 404 : 500).json({
                error: missing ? "Fajl ne postoji." : "Čitanje medija nije uspelo.",
                code: missing ? "MEDIA_NOT_FOUND" : "MEDIA_STREAM_FAILED"
            });
            return;
        }
        res.destroy(error);
    });
    stream.pipe(res);
    return stream;
}
