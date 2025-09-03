// Attendants ID to Name mapping
// Source provided by user

const ATTENDANT_ID_TO_NAME = {
  "ZrzsX_BLm_zYqujY": "Adrielli Saturnino",
  "ZuGqFp5N9i3HAKOn": "Amanda Arruda",
  "ZqOw4cIS50M0IyW4": "ANA PAULA GOMES LOPES",
  "ZaZkfnFmogpzCidw": "Ana Paula Prates",
  "Z46pqSA937XAoQjO": "Andresa Oliveira",
  "ZpZ5x2YWiurSWZw_": "Andreyna Jamilly",
  "aGevxChnIrrCytFy": "Arthur Schuster",
  "Z9h9OXksjGcTucYk": "Beatriz Padilha",
  "ZzUQwM9nj2l-H5hc": "Bruna Machado",
  "ZQxoyBkRFwc7X-Vk": "Bruna Rosângela dos Santos",
  "ZQs2aJ4vN7Fo16hX": "Cristiane Santos Sousa",
  "ZyJUBxlZDTR81qdF": "Ester Ramos",
  "ZUJgEEM61MILCE6B": "Eticléia Kletenberg",
  "ZjjGI2sLFms4kT6b": "Evylin Costa",
  "aFFip8ABDpdShgl3": "Fernando Marcelino",
  "aDcasDM8VecglMU4": "Francilaine Rosa de Oliveira",
  "aIdfZQQTEBXedrzj": "Helena Alves Iung",
  "aD7okTM8Vecg3G1-": "Henry Fernandes dos Santos",
  "ZUqcbp8LSKZvEHKO": "Isabella Reis TAcone",
  "ZaZlLHFmogpzC4xO": "Isabelle de Oliveira Guedes",
  "ZnBo4KBvCrAoRT56": "Janaina Dos Santos",
  "ZuM910xPuHH0Z4NR": "Janara Luana Copeti Teixeira",
  "ZdNO23Q4rBq-DxKh": "Josieli",
  "ZoWIY_xoe7uoAAFQ": "JULIA PERES 💙",
  "ZhqqOckvKCw7mn-Q": "Karen Letícia Nunes de Ligório",
  "ZaWZx3FmogpzwtWC": "Karol 💙",
  "ZUqdQrpYzCuTYlfc": "Karol Machado",
  "Z26n85VVIK64B6I2": "kenia silva veiga",
  "aFFuZrRwYlNQFerQ": "Lauren Silva",
  "aIdeEFZU5Fky-Vn9": "Leticia Sodre Martins",
  "ZZa0ntkTVi0FYtgX": "Lisiane Dalla Valle",
  "Zh5z4PF4WJRRo2nW": "Manoela Bernardi",
  "ZVZw4gRb-aIPaG_P": "Manuella Machado Cardoso",
  "Z-58KqwE7WFOphQ5": "Maria Julia Luiz de Sousa",
  "Zafi39QwFgY3PIe3": "Micheli Castilhos",
  "Z5e_UnhziN5VdCCp": "Micheli.M 💙",
  "aHag2aBiUL3ZL491": "Mirian Lemos",
  "ZUJNRXU0Fyap2HPj": "Paola Davila Sagaz",
  "ZW-E1ydfRz6GV84t": "Patricia Pereira",
  "aGLM6y5Rf4uSOv3n": "Pedro Moura",
  "ZaWboNQwFgY3oMeT": "Robson",
  "Z5uC3bNiUwFwQ1Dx": "Sarah Vieira",
  "Z_6kBb9UhCDQ52dN": "Wanessa Garcia"
};

function getAttendantNameById(attendantId) {
  if (!attendantId) return null;
  return ATTENDANT_ID_TO_NAME[attendantId] || null;
}

module.exports = {
  ATTENDANT_ID_TO_NAME,
  getAttendantNameById
};


