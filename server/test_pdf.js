const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

async function testParse() {
    const filePath = path.join(__dirname, '..', 'Выписка о движении ценных бумаг по счету депо (30).pdf');

    if (!fs.existsSync(filePath)) {
        console.error("File not found at:", filePath);
        return;
    }

    const dataBuffer = fs.readFileSync(filePath);

    console.log(`\n--- Parsing PDF: ${filePath} ---`);
    try {
        const result = await pdfParse(dataBuffer);

        const lines = result.text.split('\n').map(l => l.trim()).filter(l => l !== '');
        const outPath = path.join(__dirname, 'parsed_pdf.txt');

        // Дамп с номерами строк для отладки
        const numbered = lines.map((l, i) => `${i}: ${l}`).join('\n');
        fs.writeFileSync(outPath, numbered);

        console.log("SUCCESS! Dumped text to parsed_pdf.txt");
        console.log(`Всего строк: ${lines.length}`);
        console.log("\n--- Первые 80 строк ---");
        lines.slice(0, 80).forEach((l, i) => console.log(`${i}: ${l}`));
    } catch (e) {
        console.error("Error parsing PDF:", e);
    }
}

testParse().catch(console.error);
