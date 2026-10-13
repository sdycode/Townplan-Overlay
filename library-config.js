// Sheet library: GitHub releases whose assets (PDFs / images) can be browsed and added from the app.
// Add more sources here, or from the app (Library → ＋ Source).
// Sheet library: List of PCMC DP sheets hosted on GitHub
const BASE_URL = 'https://raw.githubusercontent.com/protector7251/Townplan-Sheets/main/PCMC_sheet_croped_imgs/';

const SHEET_FILES = [
  'PCMC_Sheet_01_talwade_crop.jpg',
  'PCMC_Sheet_02_talwade_chikhali_crop.jpg',
  'PCMC_Sheet_03_chikhali_crop.jpg',
  'PCMC_Sheet_04_kiwale_mamurdi_crop.jpg',
  'PCMC_Sheet_05_nigdi_ravet_crop.jpg',
  'PCMC_Sheet_06_talwade_nigdi_chikhli_crop.jpg',
  'PCMC_Sheet_07_chikhali_bohradewadi_crop.jpg',
  'PCMC_Sheet_08_moshi_borhadewadi_crop.jpg',
  'PCMC_Sheet_09_dudulgaon_crop.jpg',
  'PCMC_Sheet_10_kiwale_ravet_crop.jpg',
  'PCMC_Sheet_11_ravet_nigdi_akurdi_chinchwad_crop.jpg',
  'PCMC_Sheet_12_akurdi_crop.jpg',
  'PCMC_Sheet_13_Chikhal_Pimpri_Borhadewadi_ Bhosri_crop.jpg',
  'PCMC_Sheet_14_Borhadewadi_Moshi_Bhosari_Chovisawadi_Wadumkhwadi_Charholi_crop.jpg',
  'PCMC_Sheet_15_Chovisawadi_Wadumkhwadi_Charholi_crop.jpg',
  'PCMC_Sheet_16_charoli_crop.jpg',
  'PCMC_Sheet_17_punawale_tathawade_crop.jpg',
  'PCMC_Sheet_18_PunawalTathawade_Chinccwad_Thergaon_crop.jpg',
  'PCMC_Sheet_19_Thergaon_Pimpri_Chinchwad_Rahatani_crop.jpg',
  'PCMC_Sheet_20_pimpri_bhosri_crop.jpg',
  'PCMC_Sheet_21_bhosri-dighi_crop.jpg',
  'PCMC_Sheet_22_charoli_crop.jpg',
  'PCMC_Sheet_23_charoli_crop.jpg',
  'PCMC_Sheet_24_wakad-tathawade_crop.jpg',
  'PCMC_Sheet_25_Tathawade_Wakad_Thergaon_Rahatani_crop.jpg',
  'PCMC_Sheet_26_pimpri_rahtani_pimple_crop.jpg',
  'PCMC_Sheet_27_Pimpri_Bhosri_PimpleGurav_crop.jpg',
  'PCMC_Sheet_28_dighi_crop.jpg',
  'PCMC_Sheet_29_wakad_nilakh_crop.jpg',
  'PCMC_Sheet_30_Pimple Nilakh_Pimple Saudagar_Pimple Gurav_crop.jpg',
  'PCMC_Sheet_31_dapodi_sangvi_crop.jpg',
  'PCMC_Sheet_32_Bopkhel_crop.jpg',
];

window.LIBRARY_SOURCES = [
  {
    label: 'PCMC DP sheets (32 images)',
    // Map each filename to an item object with name and full raw URL
    items: SHEET_FILES.map((name) => ({
      name,
      size: 0,
      url: BASE_URL + encodeURIComponent(name),
    })),
  },
];
