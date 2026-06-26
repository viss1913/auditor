const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeSecurityName,
    extractFromSecurityText,
    resolveSecurity,
    buildSecurityMatchKeys,
    buildSecurityCrosswalk,
    enrichRowWithSecurity,
} = require('./security_resolver');

describe('security_resolver', () => {
    it('normalizeSecurityName: УК и брокер', () => {
        assert.equal(normalizeSecurityName('мечел, ап'), 'мечел');
        assert.equal(normalizeSecurityName('ПАО "Мечел" АП'), 'мечел');
    });

    it('extractFromSecurityText: встроенные ISIN и reg', () => {
        const x = extractFromSecurityText('ПАО "Мечел" АП ISIN RU0009084396 2-01-55005-E');
        assert.equal(x.isin, 'RU0009084396');
        assert.ok(x.regNum.includes('55005'));
        assert.equal(normalizeSecurityName(x.name), 'мечел');
    });

    it('resolveSecurity: УК с коротким regNum', () => {
        const sec = resolveSecurity(
            { period: '30.12.2024', name: 'Мечел, ап', regNum: 'ап', quantity: 10 },
            { side: 'uk' }
        );
        assert.equal(sec.coreName, 'мечел');
        assert.equal(sec.regSuffix, 'ап');
        assert.ok(sec.matchKeys.some((k) => k === 'name:мечел|ап'));
    });

    it('resolveSecurity: брокер с полным reg и ISIN', () => {
        const sec = resolveSecurity(
            {
                name: 'ПАО "Мечел" АП',
                regNum: '2-01-55005-E',
                isin: 'RU0009084396',
            },
            { side: 'broker' }
        );
        assert.equal(sec.isin, 'RU0009084396');
        assert.ok(sec.matchKeys.some((k) => k.startsWith('isin:')));
        assert.ok(sec.matchKeys.some((k) => k.startsWith('reg:')));
    });

    it('crosswalk: UK получает ISIN из брокера', () => {
        const crosswalk = buildSecurityCrosswalk([
            [{ name: 'Мечел, ап', regNum: 'ап' }],
            [{ name: 'ПАО "Мечел" АП', regNum: '2-01-55005-E', isin: 'RU0009084396' }],
        ]);
        const uk = enrichRowWithSecurity({ name: 'Мечел, ап', regNum: 'ап' }, { side: 'uk', crosswalk });
        assert.equal(uk._security_core_name, 'мечел');
        assert.ok(uk._security_match_keys.some((k) => k === 'name:мечел|ап'));
    });

    it('buildSecurityMatchKeys: приоритет isin > reg > name', () => {
        const keys = buildSecurityMatchKeys({
            isin: 'RU0009084396',
            regNumFull: '20155005E',
            coreName: 'мечел',
            regSuffix: 'ап',
        });
        assert.equal(keys[0], 'isin:RU0009084396');
        assert.ok(keys.includes('name:мечел|ап'));
    });
});
