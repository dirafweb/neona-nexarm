import { createHash, randomBytes } from "node:crypto";

/** La base guarda solo el hash: el token se muestra una vez, al crearlo o rotarlo. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const newToken = () => `nxa_${randomBytes(32).toString("base64url")}`;
