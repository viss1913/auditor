const fs = require('fs');

/** Дескриптор inbox → объект как после multer (с buffer для Excel/txt). */
function loadInboxDescriptor(entry) {
    const buffer = fs.readFileSync(entry.absolutePath);
    return {
        buffer,
        originalname: entry.name,
        name: entry.name,
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        size: entry.size,
    };
}

function loadInboxDescriptors(entries, { withBuffer = true } = {}) {
    return (entries || []).map((entry) => {
        if (!withBuffer && entry.absolutePath) {
            return {
                originalname: entry.name,
                name: entry.name,
                relativePath: entry.relativePath,
                absolutePath: entry.absolutePath,
                size: entry.size,
            };
        }
        return loadInboxDescriptor(entry);
    });
}

module.exports = { loadInboxDescriptor, loadInboxDescriptors };
