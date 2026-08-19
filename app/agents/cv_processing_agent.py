import re
from pathlib import Path

import fitz
from docx import Document

from app.agents.base import BaseAgent

# Referentiel de competences elargi (IT/data, RH, industrie/production, qualite,
# maintenance) afin de couvrir les profils types recus par SONASID Nador.
KNOWN_SKILLS = [
    "python", "power bi", "excel", "sql", "mongodb", "fastapi", "data analysis",
    "machine learning", "deep learning", "power query", "vba", "r", "java",
    "javascript", "sap", "erp", "tableau", "looker", "pandas", "numpy",
    "ressources humaines", "recrutement", "paie", "gestion administrative",
    "droit social", "sirh", "gestion de projet", "gestion budget formation",
    "ingenierie pedagogique", "communication", "reporting",
    "maintenance", "maintenance preventive", "maintenance corrective",
    "electromecanique", "automatisme", "electricite industrielle",
    "securite", "securite industrielle", "hse", "hygiene et securite",
    "qualite", "iso", "iso 9001", "audit", "controle qualite", "amelioration continue",
    "lean manufacturing", "six sigma", "production", "logistique", "supply chain",
    "gestion de stock", "achat", "comptabilite", "finance", "controle de gestion",
    "anglais", "francais", "arabe", "espagnol",
]

# Mots-cles de diplome/niveau d'etudes, du plus eleve au plus bas, avec un
# libelle lisible pour le service RH. Le premier motif trouve dans le CV
# donne le niveau retenu.
DIPLOMA_PATTERNS: list[tuple[str, str]] = [
    (r"doctorat|ph\.?d", "Doctorat"),
    (r"master\s*2|m2\b|bac\s*\+\s*5|dipl[oô]me d'ing[eé]nieur|ing[eé]nieur d'[eé]tat|mba", "Master / Ingenieur (Bac+5)"),
    (r"master(?!\s*2)|bac\s*\+\s*4", "Master (Bac+4/5)"),
    (r"licence professionnelle|licence|bac\s*\+\s*3", "Licence (Bac+3)"),
    (r"bts|dut|bac\s*\+\s*2|deug", "BTS / DUT (Bac+2)"),
    (r"baccalaur[eé]at|\bbac\b(?!\s*\+)", "Baccalaureat"),
]

# Intitules de poste/profil frequemment presents dans les CV recus, utilises
# pour deviner le profil du candidat quand aucun titre explicite n'est trouve
# dans les premieres lignes.
PROFILE_KEYWORDS: list[tuple[str, str]] = [
    (r"data analyst", "Data Analyst"),
    (r"data scientist", "Data Scientist"),
    (r"ressources humaines|rh\b|charg[eé] de recrutement|responsable rh", "Profil Ressources Humaines"),
    (r"technicien(ne)? de maintenance|maintenance", "Technicien(ne) Maintenance"),
    (r"ing[eé]nieur qualit[eé]|responsable qualit[eé]|qualit[eé]", "Profil Qualite"),
    (r"responsable formation|formateur", "Responsable Formation"),
    (r"comptable|finance|contr[oô]le de gestion", "Profil Comptabilite / Finance"),
    (r"d[eé]veloppeur|ing[eé]nieur logiciel|software engineer", "Developpeur / Ingenieur logiciel"),
    (r"logistique|supply chain", "Profil Logistique / Supply Chain"),
    (r"production|op[eé]rateur", "Profil Production"),
]

NAME_LINE_PATTERN = re.compile(r"^[A-ZÀ-Ý][a-zà-ÿ'’\-]+(?:\s+[A-ZÀ-Ý][A-Za-zà-ÿ'’\-]+){0,3}$")
NAME_EXCLUDE_WORDS = {"cv", "curriculum", "vitae", "resume", "profil", "profile"}

EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
# Numeros marocains (+212/00212/0) et formats generiques avec separateurs.
PHONE_PATTERN = re.compile(r"(?:\+212|00212|0)[\s.\-]?(?:5|6|7)(?:[\s.\-]?\d{2}){4}")
EXPERIENCE_YEARS_PATTERN = re.compile(r"(\d{1,2})\s*(?:\+)?\s*(?:ans|ann[eé]es)\s*(?:d['’]exp[eé]rience|d'exp[eé]rience)?", re.IGNORECASE)
YEAR_RANGE_PATTERN = re.compile(r"\b(19|20)\d{2}\b.{0,15}?(?:-|à|au|/)\s*(?:\b(19|20)\d{2}\b|pr[eé]sent|actuel|aujourd)", re.IGNORECASE)


class CVProcessingAgent(BaseAgent):
    name = "cv_processing_agent"

    def extract_text(self, file_path: str) -> str:
        path = Path(file_path)
        suffix = path.suffix.lower()

        if suffix == ".pdf":
            with fitz.open(file_path) as document:
                return "\n".join(page.get_text() for page in document)

        if suffix == ".docx":
            document = Document(file_path)
            return "\n".join(paragraph.text for paragraph in document.paragraphs)

        raise ValueError("Format CV non supporte. Utilise PDF ou DOCX.")

    def _extract_name(self, lines: list[str]) -> str | None:
        for line in lines[:8]:
            candidate = line.strip()
            words = candidate.split()
            if not (1 <= len(words) <= 4):
                continue
            if any(word.lower() in NAME_EXCLUDE_WORDS for word in words):
                continue
            if any(char.isdigit() for char in candidate):
                continue
            if "@" in candidate or "http" in candidate.lower():
                continue
            if NAME_LINE_PATTERN.match(candidate) or candidate.isupper():
                return candidate.title() if candidate.isupper() else candidate
        return None

    def _extract_diploma(self, lowered_text: str) -> str | None:
        for pattern, label in DIPLOMA_PATTERNS:
            if re.search(pattern, lowered_text):
                return label
        return None

    def _extract_profile(self, lowered_text: str, lines: list[str]) -> str | None:
        for line in lines[:10]:
            lowered_line = line.lower()
            for pattern, label in PROFILE_KEYWORDS:
                if re.search(pattern, lowered_line):
                    return label
        for pattern, label in PROFILE_KEYWORDS:
            if re.search(pattern, lowered_text):
                return label
        return None

    def _extract_email(self, text: str) -> str | None:
        match = EMAIL_PATTERN.search(text)
        return match.group(0) if match else None

    def _extract_phone(self, text: str) -> str | None:
        match = PHONE_PATTERN.search(text)
        return re.sub(r"[\s.\-]", " ", match.group(0)).strip() if match else None

    def _extract_experience_years(self, lowered_text: str) -> int | None:
        # 1) mention explicite ("3 ans d'experience")
        matches = [int(m.group(1)) for m in EXPERIENCE_YEARS_PATTERN.finditer(lowered_text)]
        if matches:
            return max(matches)
        return None

    def _extract_experience_lines(self, lines: list[str]) -> list[str]:
        # Lignes contenant une periode (ex: "2019 - 2022 : Data Analyst chez X")
        # affichees telles quelles pour que le RH juge lui-meme, plutot qu'une
        # reformulation automatique qui pourrait deformer le CV.
        found = []
        for line in lines:
            if YEAR_RANGE_PATTERN.search(line) and len(line) < 160:
                found.append(line)
            if len(found) >= 6:
                break
        return found

    def extract_profile(self, text: str) -> dict:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        lowered = text.lower()

        # Recherche par limites de mots pour eviter les faux positifs
        # (ex: la lettre seule "r" ne doit pas matcher dans "experience").
        skills = [
            skill for skill in KNOWN_SKILLS
            if re.search(r"(?<![a-z0-9])" + re.escape(skill) + r"(?![a-z0-9])", lowered)
        ]

        return {
            "name": self._extract_name(lines),
            "diploma": self._extract_diploma(lowered),
            "profile": self._extract_profile(lowered, lines),
            "summary": " ".join(lines[:5]),
            "skills": skills,
            "text_length": len(text),
            "email": self._extract_email(text),
            "phone": self._extract_phone(text),
            "experience_years": self._extract_experience_years(lowered),
            "experience_lines": self._extract_experience_lines(lines),
        }
