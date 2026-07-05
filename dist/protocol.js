const REQUIRED_STRING_FIELDS = {
    "sessions.list": [],
    "sessions.create": [],
    "sessions.resume": ["path"],
    "sessions.delete": ["path"],
    "session.attach": ["sessionId"],
    "session.detach": ["sessionId"],
    "session.prompt": ["sessionId", "text"],
    "session.steer": ["sessionId", "text"],
    "session.followup": ["sessionId", "text"],
    "session.command": ["sessionId", "text"],
    "session.abort": ["sessionId"],
    "session.compact": ["sessionId"],
    "session.compact_abort": ["sessionId"],
    "session.set_model": ["sessionId", "provider", "modelId"],
    "session.set_thinking": ["sessionId", "level"],
    "session.rename": ["sessionId", "name"],
    "commands.list": ["sessionId"],
    "models.list": [],
    ping: [],
};
const IMAGE_CAPABLE_TYPES = new Set(["session.prompt", "session.steer", "session.followup"]);
export const MAX_IMAGES_PER_MESSAGE = 8;
export class ProtocolError extends Error {
}
function validateImages(msg, type) {
    if (msg.images === undefined)
        return;
    if (!IMAGE_CAPABLE_TYPES.has(type)) {
        throw new ProtocolError(`Request "${type}" does not accept images`);
    }
    if (!Array.isArray(msg.images)) {
        throw new ProtocolError(`Request "${type}" field "images" must be an array`);
    }
    if (msg.images.length > MAX_IMAGES_PER_MESSAGE) {
        throw new ProtocolError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message`);
    }
    for (const image of msg.images) {
        const record = image;
        if (typeof record !== "object" ||
            record === null ||
            typeof record.data !== "string" ||
            record.data === "" ||
            typeof record.mimeType !== "string" ||
            !record.mimeType.startsWith("image/")) {
            throw new ProtocolError(`Each image needs base64 "data" and an image/* "mimeType"`);
        }
    }
}
export function parseClientRequest(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ProtocolError("Message is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new ProtocolError("Message must be a JSON object");
    }
    const msg = parsed;
    if (typeof msg.id !== "number") {
        throw new ProtocolError("Message must carry a numeric id");
    }
    const type = msg.type;
    if (typeof type !== "string" || !(type in REQUIRED_STRING_FIELDS)) {
        throw new ProtocolError(`Unknown request type "${String(type)}"`);
    }
    for (const field of REQUIRED_STRING_FIELDS[type]) {
        const emptyAllowed = field === "text" && Array.isArray(msg.images) && msg.images.length > 0;
        if (typeof msg[field] !== "string" || (msg[field] === "" && !emptyAllowed)) {
            throw new ProtocolError(`Request "${type}" requires string field "${field}"`);
        }
    }
    validateImages(msg, type);
    return msg;
}
//# sourceMappingURL=protocol.js.map