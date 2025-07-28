'use strict';

const noopGroupTransformer = async (entity, _user, _realm) => entity;
const noopUserTransformer = async (entity, _user, _realm, _groups) => entity;
const sanitizeEmailTransformer = async (entity, _user, _realm, _groups) => {
  entity.metadata.name = entity.metadata.name.replace(/[^a-zA-Z0-9]/g, "-");
  return entity;
};

exports.noopGroupTransformer = noopGroupTransformer;
exports.noopUserTransformer = noopUserTransformer;
exports.sanitizeEmailTransformer = sanitizeEmailTransformer;
//# sourceMappingURL=transformers.cjs.js.map
