/** Identity function that pins the generic parameters so handlers are typed. */
export function operation(definition) {
    return definition;
}
/** Capabilities every surface can satisfy on its own. */
export const PORTABLE = new Set(["net", "fs", "shell", "secret"]);
/** Whether a surface can run an operation: MCP needs a portable one; a CLI also has a human for user-input. */
export function serves(operation, surface) {
    return (operation.requires ?? []).every((capability) => PORTABLE.has(capability) || (surface === "cli" && capability === "user-input"));
}
