export declare const SPOT_STUDY_SOURCES: string[];
export declare function runSpotStudy(dataRoot: string, output: string): Promise<{
    generatedAtUtc: string;
    strategyVersion: "btc-spot-funded-weekly-trend-v1";
    sourceHashes: {
        [k: string]: string;
    };
    sourceDataSha256: string;
    datasetSha256: string;
    coverage: {
        originalRows: number;
        retainedBars: number;
        firstOpenMs: number;
        lastEndMs: number;
        excludedIncomplete: number;
        gaps: Array<{
            fromMs: number;
            toMs: number;
            weeks: number;
        }>;
    };
    researchPaperEligible: boolean;
    checks: {
        allRunsTerminalFlat: boolean;
        bothPrimaryScenariosPositive: boolean;
        enoughEpisodesInEachScenario: boolean;
        lessStressDollarDrawdownThanBuyHold: boolean;
        noAccountDrawdownHalt: boolean;
        netExceedsAllocatedCapitalHurdleBothScenarios: boolean;
    };
    bootstrap: {
        lowerMeanWeeklyNetUsd: null;
        completeWeeks: number;
        blocks: number;
    } | {
        lowerMeanWeeklyNetUsd: number;
        completeWeeks: number;
        blocks: number;
    };
    lowerBootstrapMeanPositive: boolean;
    provenProfitable: boolean;
    independentValidationPassed: boolean;
    existingFuturesEngineChanged: boolean;
    liveTradingAllowed: boolean;
    runtimeActivated: boolean;
    runs: {
        version: string;
        policy: import("./spec.js").SpotPolicy;
        scenario: import("./spec.js").SpotScenario;
        startMs: number;
        endMs: number;
        firstEligibleExecutionOpenMs: number | null;
        finalEligibleExecutionOpenMs: number | null;
        initialCashUsd: number;
        initialEntryBudgetUsd: number;
        finalCashUsd: number;
        finalQuantity: number;
        netPnlUsd: number;
        realizedNetUsd: number;
        feesUsd: number;
        closedEpisodes: number;
        netReturnOnInitialEntryBudgetFraction: number;
        drawdownOnInitialEntryBudgetFraction: number;
        netAccountReturnFraction: number;
        buys: number;
        sells: number;
        turnoverUsd: number;
        investedWeeks: number;
        maximumMarkedNotionalUsd: number;
        maxWeeklyCloseDrawdownUsd: number;
        sampledPeakToWeeklyLowUsd: number;
        accountDrawdownHalted: boolean;
        terminalFlat: boolean;
        fivePercentInitialBudgetHurdleUsd: number;
        netAboveAllocatedCapitalHurdleUsd: number;
        window: string;
        file: string;
    }[];
    limitations: string[];
}>;
