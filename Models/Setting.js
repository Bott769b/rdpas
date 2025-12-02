const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // misal: 'success_sticker_id'
    value: { type: String, required: true }, // misal: 'CAACAgIAAxkBAA...'
});

const Setting = mongoose.model('Setting', settingSchema);
module.exports = Setting;