import * as core from '@actions/core';

type QueueResponse = {
    simulation_run_id: string;
    agent_id: string;
    status: string;
};

type SimulationRunDetails = {
    id: string;
    simulation_id: string;
    summary: string;
    status: string;
    total_tests: number;
    tests_passed: number;
    tests_failed: number;
    tests_completed: number;
    tests_incompleted: number;
    created_at: string;
};

type RetrieveSimulationResponse = {
    simulation_run: SimulationRunDetails;
    simulation_results: any[];
    status: string;
};

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBool(input: string | undefined, defaultValue: boolean): boolean {
    if (input === undefined || input === '') return defaultValue;
    const normalized = input.toLowerCase().trim();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
    return defaultValue;
}

async function run() {
    try {
        const apiKey = core.getInput('api_key', { required: true });
        const simulationId = core.getInput('simulation_id', { required: true });
        const promptId = core.getInput('prompt_id');
        const knowledgeBaseId = core.getInput('knowledge_base_id');
        const digitalHumanIdsInput = core.getInput('digital_human_ids');
        const phoneNumber = core.getInput('phone_number');
        const sipUri = core.getInput('sip_uri');

        const waitForResults = parseBool(core.getInput('wait_for_results'), true);
        const minScore = Number(core.getInput('min_score') || '80');
        const pollIntervalSeconds = Number(core.getInput('poll_interval_seconds') || '10');
        const timeoutSeconds = Number(core.getInput('timeout_seconds') || '1500');

        if (!apiKey) {
            throw new Error('api_key is required');
        }
        if (!simulationId) {
            throw new Error('simulation_id is required');
        }

        core.info(`Queuing Bluejay simulation run for simulation_id=${simulationId} ...`);

        const digitalHumanIds = digitalHumanIdsInput
            ? digitalHumanIdsInput.split(',').map((s) => s.trim()).filter(Boolean)
            : null;

        // 1) Queue the simulation run
        const queueResp = await fetch('https://api.getbluejay.ai/v1/queue-simulation-run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey
            },
            body: JSON.stringify({
                simulation_id: simulationId,
                prompt_id: promptId || null,
                knowledge_base_id: knowledgeBaseId || null,
                digital_human_ids: digitalHumanIds,
                phone_number: phoneNumber || null,
                sip_uri: sipUri || null
            })
        });

        const queueText = await queueResp.text();
        if (!queueResp.ok) {
            core.error(`Bluejay API error (queue): ${queueText}`);
            throw new Error(`Failed to queue simulation run: HTTP ${queueResp.status}`);
        }

        let queueData: QueueResponse;
        try {
            queueData = JSON.parse(queueText);
        } catch (e) {
            core.error(`Failed to parse queue response JSON: ${queueText}`);
            throw e;
        }

        const simulationRunId = queueData.simulation_run_id;
        core.info(`Bluejay simulation run queued successfully: ${simulationRunId}`);

        core.setOutput('simulation-run-id', simulationRunId);

        // If user only wants to queue, don't wait
        if (!waitForResults) {
            core.info('wait_for_results=false, not polling for simulation results.');
            return;
        }

        // 2) Poll for simulation results
        core.info('Waiting for Bluejay simulation results...');
        const startTime = Date.now();
        let lastStatus = 'queued';
        let finalResult: RetrieveSimulationResponse | null = null;

        while (true) {
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            if (elapsedSeconds > timeoutSeconds) {
                throw new Error(
                    `Timed out after ${timeoutSeconds}s waiting for simulation_run_id=${simulationRunId}`
                );
            }

            const statusResp = await fetch(
                `https://api.getbluejay.ai/v1/retrieve-simulation-results/${encodeURIComponent(
                    simulationRunId
                )}`,
                {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': apiKey
                    }
                }
            );

            const statusText = await statusResp.text();
            if (!statusResp.ok) {
                core.error(`Bluejay API error (status): ${statusText}`);
                throw new Error(
                    `Failed to fetch simulation status: HTTP ${statusResp.status}`
                );
            }

            let statusData: RetrieveSimulationResponse;
            try {
                statusData = JSON.parse(statusText);
            } catch (e) {
                core.error(`Failed to parse status response JSON: ${statusText}`);
                throw e;
            }

            finalResult = statusData;
            lastStatus = statusData.simulation_run.status;
            const totalTests = statusData.simulation_run.total_tests || 0;
            const testsPassed = statusData.simulation_run.tests_passed || 0;
            const score = totalTests > 0 ? (testsPassed / totalTests) * 100 : 0;

            core.info(
                `Current simulation status=${lastStatus}, passed=${testsPassed}/${totalTests}, calculated_score=${score.toFixed(
                    1
                )}`
            );

            // Normalize status for checking completion
            const s = lastStatus.toLowerCase();
            if (['completed', 'failed', 'cancelled', 'success', 'error'].includes(s)) {
                break;
            }

            await sleep(pollIntervalSeconds * 1000);
        }

        // 3) Set outputs based on result
        core.setOutput('final-status', lastStatus);

        const finalTotal = finalResult?.simulation_run.total_tests || 0;
        const finalPassed = finalResult?.simulation_run.tests_passed || 0;
        const finalScore = finalTotal > 0 ? (finalPassed / finalTotal) * 100 : 0;

        core.setOutput('score', String(finalScore));

        // 4) Decide CI success/failure
        const normalizedStatus = lastStatus.toLowerCase();
        if (normalizedStatus !== 'completed' && normalizedStatus !== 'success') {
            core.setFailed(
                `Bluejay simulation_run_id=${simulationRunId} ended with status=${lastStatus}`
            );
            return;
        }

        if (finalScore < minScore) {
            core.setFailed(
                `Bluejay overall_score=${finalScore} is below minimum threshold=${minScore}`
            );
        } else {
            core.info(
                `Bluejay overall_score=${finalScore} meets or exceeds threshold ${minScore}.`
            );
        }
    } catch (error: any) {
        core.setFailed(error?.message ?? String(error));
    }
}

run();
