const { buildParseValidationReport } = require('./parse_validation_report');



/**

 * Проверка preview после парса — структурная правдоподобность.

 * Thin-wrapper над buildParseValidationReport.

 */

function structureValidatePreview(structureId, scenarioId, preview, structure = null) {

    const report = buildParseValidationReport({

        structure: structure || { structure_id: structureId },

        scenarioId,

        preview,

    });

    return report.ok;

}



module.exports = {

    structureValidatePreview,

};

