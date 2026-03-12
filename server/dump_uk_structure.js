const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const uploadsDir = 'c:/Users/User/Desktop/auditor_3/server/uploads';
const files = fs.readdirSync(uploadsDir);

// Ищем файл, который похож на УК (болшой размер или попробуем первый попавшийся)
// На самом деле, лучше просто попросим Сашу сказать какой файл.
// Но попробуем сами.

async function findAndDump() {
    for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try {
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

            // Если в 7-й строке или около того есть слова "Карточка счета"
            let isUK = false;
            for (let i = 0; i < 20; i++) {
                if (String(data[i] || '').includes('Карточка счета')) {
                    isUK = true;
                    break;
                }
            }

            if (isUK) {
                console.log(`=== Найден УК файл: ${file} ===`);
                // Дампим строки 7-30
                for (let i = 0; i < 50; i++) {
                    console.log(`Row ${i}:`, JSON.stringify(data[i]));
                }
                return;
            }
        } catch (e) { }
    }
    console.log('УК файл не найден');
}

findAndDump();
