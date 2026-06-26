const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildStructureOntology,
    applyOntologyTieBreak,
    resolveScenarioFromOntology,
} = require('./structure_ontology');
const { classifySheetStructure } = require('./structure_classifier');

function buildUkJournalRows() {
    const rows = [];
    for (let i = 0; i < 7; i += 1) rows.push(Array(11).fill(''));
    rows.push([
        'Период',
        'Документ',
        '',
        'Аналитика Дт',
        'Аналитика Кт',
        'Показатель',
        'Дебет',
        '',
        'Кредит',
        '',
        'Текущее сальдо',
    ]);
    rows.push(['', '', '', '', '', '', 'Счет', '', 'Счет', '', '']);
    for (let i = 0; i < 50; i += 1) {
        const d = `${String((i % 28) + 1).padStart(2, '0')}.12.2024`;
        rows.push([d, 'Сделка', '', 'Бумага TEST', '', 'БУ', '58.01.4', 1000 + i, '', '76.07.2', '', '']);
        rows.push(['', '', '', '', '', 'Кол.', '', 10, '', '', '', '']);
    }
    return rows;
}

describe('structure_ontology', () => {
    it('bu_kol_pairs + dtKt → suggested_scenario uk_card', () => {
        const data = buildUkJournalRows();
        const structure = classifySheetStructure(data);
        const ontology = buildStructureOntology(data, { structure, ranked: structure.ranked });
        assert.equal(ontology.row_pattern, 'bu_kol_pairs');
        assert.equal(ontology.suggested_scenario, 'uk_card');
        assert.equal(ontology.suggested_structure_id, 'uk_journal_58');
        assert.ok(ontology.account_signals.bu58 >= 2);
        assert.ok(ontology.uk_probe?.indicator_column != null);
    });

    it('applyOntologyTieBreak: uk_journal_58 побеждает journal_1c', () => {
        const data = buildUkJournalRows();
        const ranked = [
            { structure_id: 'journal_1c', confidence: 0.98, reason: 'journal' },
            { structure_id: 'uk_journal_58', confidence: 0.97, reason: 'uk' },
        ];
        const fixed = applyOntologyTieBreak(ranked, data);
        assert.equal(fixed[0].structure_id, 'uk_journal_58');
        assert.ok(fixed[0].confidence >= fixed[1].confidence);
    });

    it('resolveScenarioFromOntology: journal_1c в classifier, но bu_kol → uk_card', () => {
        const scenario = resolveScenarioFromOntology({
            row_pattern: 'bu_kol_pairs',
            account_signals: { bu58: 5, kol_rows: 5 },
            suggested_scenario: 'uk_card',
        });
        assert.equal(scenario, 'uk_card');
    });

    it('parser_rule в ontology для bu_kol', () => {
        const data = buildUkJournalRows();
        const structure = classifySheetStructure(data);
        const ontology = buildStructureOntology(data, { structure, ranked: structure.ranked });
        assert.equal(ontology.parser_rule?.scenarioId, 'uk_card');
        assert.equal(ontology.parser_rule?.structure_id, 'uk_journal_58');
    });

    it('buildStructureOntology survives 31k rowOutlineLevels without stack overflow', () => {
        const data = buildUkJournalRows();
        const structure = classifySheetStructure(data);
        const levels = new Array(31215).fill(0);
        assert.doesNotThrow(() =>
            buildStructureOntology(data, {
                structure,
                ranked: structure.ranked,
                rowOutlineLevels: levels,
            })
        );
    });
});
