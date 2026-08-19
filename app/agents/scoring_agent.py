from app.agents.base import BaseAgent


class ScoringAgent(BaseAgent):
    name = "scoring_agent"

    def score_candidate(self, candidate_profile: dict, target_position: dict | None = None) -> dict:
        skills = set(candidate_profile.get("skills", []))
        required_skills = set((target_position or {}).get("required_skills", []))

        if required_skills:
            skill_score = len(skills.intersection(required_skills)) / len(required_skills)
        else:
            skill_score = min(len(skills) / 6, 1)

        final_score = round(skill_score * 100, 2)
        adapted_skills = sorted(skills.intersection(required_skills)) if required_skills else sorted(skills)
        not_adapted_skills = sorted(required_skills - skills) if required_skills else []
        return {
            "score": final_score,
            "matched_skills": adapted_skills,
            # Alias explicites "adapte / non adapte" utilises par la page Analyse CV.
            "adapted_skills": adapted_skills,
            "not_adapted_skills": not_adapted_skills,
            "recommendation": "preselection" if final_score >= 60 else "a_revoir",
        }
