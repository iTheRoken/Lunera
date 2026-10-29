'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {translate,languages,rows}=require('../services/translations');
test('Todos los idiomas tienen traducciones y conservan textos de usuario desconocidos',()=>{
 for(const row of rows){assert.equal(row.length,languages.length);for(const value of row)assert.ok(value.trim());}
 for(const language of languages.slice(1)){
   assert.notEqual(translate('Configuración',language),'Configuración');
   assert.equal(translate('Mi canción de prueba #192',language),'Mi canción de prueba #192');
 }
 assert.equal(translate('  BUSCAR  ','en'),'  SEARCH  ');
 assert.equal(translate('Inicio','es'),'Inicio');
 assert.equal(translate('Inicio','unknown'),'Inicio');
});
