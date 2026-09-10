export interface SpotPaperEvidence {
    evidenceSha256: string;
    reportSha256: string;
    auditSha256: string;
    sourceHashes: Record<string, string>;
    summary: {
        baseNetUsd: number;
        stressNetUsd: number;
        baseEpisodes: number;
        stressEpisodes: number;
        lowerMeanWeeklyNetUsd: number | null;
        provenProfitable: false;
    };
}
/** An audited historical nomination can permit research paper only, never assert profit. */
export declare function loadSpotPaperEvidence(studyDirectory: string, auditFile: string, repoRoot?: string): Promise<SpotPaperEvidence>;
