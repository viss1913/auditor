require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const {
    parseRequestedTableColumns,
    buildScanTableFromExtraction,
    extractScannedDocument,
} = require('../document_scan_llm');

const PDF_PATH =
    process.argv[2] ||
    String.raw`c:\Users\User\AppData\Roaming\Cursor\User\workspaceStorage\a7a546b122918814567298d87a2d2421\pdfs\9ec6869d-8249-41e8-8d40-ba7d8763a79a\2025.04.14_Годовой отчет за 2024г..pdf`;

const USER_MESSAGE = `надо создать таблицу:
Название ООО 
ИНН
место нахождения офиса
Устанвный капитал`;

async function main() {
    console.log('PDF:', PDF_PATH);
    if (!fs.existsSync(PDF_PATH)) {
        console.error('File not found');
        process.exit(1);
    }

    const cols = parseRequestedTableColumns(USER_MESSAGE);
    console.log('\n=== parseRequestedTableColumns ===');
    console.log(JSON.stringify(cols, null, 2));

    const buffer = fs.readFileSync(PDF_PATH);
    console.log('\n=== Vision extract (model:', process.env.VISION_MODEL, ') ===');
    const extracted = await extractScannedDocument({
        buffer,
        mimeType: 'application/pdf',
        fileName: path.basename(PDF_PATH),
        userMessage: USER_MESSAGE,
    });

    console.log('\n--- raw extraction ---');
    console.log(JSON.stringify(extracted, null, 2));

    const table = buildScanTableFromExtraction(extracted, USER_MESSAGE);
    console.log('\n=== buildScanTableFromExtraction ===');
    console.log(JSON.stringify(table, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
