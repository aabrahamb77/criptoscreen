'use strict';
/**
 * bot/metrics.js
 * Reexporta las métricas del módulo compartido public/lxr.js (UMD).
 * Antes esta lógica estaba duplicada aquí y en el navegador; ahora vive en
 * UN solo archivo para que bot y frontend no puedan divergir.
 */
const LXR = require('../public/lxr.js');

module.exports = { ...LXR.metrics };
