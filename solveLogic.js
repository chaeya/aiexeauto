import puppeteer from 'puppeteer';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { highlight } from 'cli-highlight';
import ora from 'ora';
import boxen from 'boxen';

import { importData, exportData } from './dataHandler.js';
import { chatCompletion } from './aifeatures.js';
import { checkValidSyntaxJavascript, stripFencedCodeBlocks, runCode, getRequiredPackageNames } from './codeExecution.js';
import { getLastDirectoryName } from './dataHandler.js';
import { config } from './config.js';
import { getDockerInfo, runDockerContainer, killDockerContainer, runDockerContainerDemon, importToDocker, exportFromDocker, runNodeJSCode, doesDockerImageExist } from './docker.js';
import fs from 'fs';

let containerId;
let spinners = {};

// Collecting prompts in one place
const prompts = {
    initialPlan: (mission) => [
        '미션:',
        config.threeBackticks,
        `${mission}`,
        config.threeBackticks,
        '',
        '주어진 미션을 NodeJS 코드를 이용해서 완수하기 위해 필요한 논리적인 단계를 나열해 주세요.',
        '소스 코드는 포함하지 마세요.',
        '논리적으로 단계별로 생각해 보세요.',
    ].join('\n').trim(),

    systemPrompt: (mission, whattodo) => [
        '컴퓨터 작업 실행 에이전트로서, 주어진 미션을 처리하기 위해 node.js 코드로 명령어를 작성한다.',
        'MAIN MISSION을 완수하기 위한 SUB MISSION을 수행한다.',
        `- MAIN MISSION: "${mission}"`,
        `- SUB MISSION: "${whattodo}"`,
    ].join('\n'),
    systemEvaluationPrompt: (mission) => [
        '컴퓨터작업을 수행하는 에이전트로써 미션이 완전하게 완료되었는지 엄격하게 검증하고 평가하는 역할을 합니다.',
        `MISSION: "${mission}"`,
    ].join('\n'),

    packageNamesPrompt: [
        '주어진 Node.js 코드를 실행하기 위해 필요한 패키지들을 나열하세요.',
        '',
        '출력 형식:',
        '- 설명 없이 패키지 이름만 JSON 배열로 반환하세요.',
        '- 마크다운 코드 블록을 사용하지 마세요.',
        '- 자연어 텍스트를 포함하지 마세요.',
        '',
        '예시 출력:',
        '["패키지명1", "패키지명2", ...]',
    ].join('\n'),

    evaluationPrompt_backup: (outputPreview, endSign, solution) => [
        '코드 실행 결과가 미션 완료를 나타내는지 평가하고 다음 작업을 수행할 코드를 작성해 주세요.',
        '',
        '코드 실행 결과:',
        '```shell',
        `$ node code.js`,
        `${outputPreview}`,
        '```',
        '',
        '평가 결과에 따라 다음을 수행하세요:',
        `- **평가 근거가 불충분하면**, 추가 증거를 수집하고 검증을 위해 출력 길이를 제한한 코드를 작성하세요.`,
        `- **미션이 실패했다고 판단되면**, 오류를 발생시킨 방법을 사용하지 말고 새로운 방법으로 미션을 완수하는 새로운 코드를 작성하세요.`,
        '',
        '코드 수행 지침:',
        '- 코드는 단일 JavaScript 파일로 완전하고 실행 가능해야 합니다.',
        '- 진행 단계마다 `console.log`를 사용하여 상태값과 진행상황을 출력하세요.',
        '- 이전 결과에 문제가 있다면 수정하는 코드를 작성하세요.',
        '- 추가 증거를 수집할 때는 분석을 위해 출력 길이를 제한하세요.',
        '- 시각화를 하는 미션의 경우는 시각화된 결과물인 html 파일의 존재유무를 중점으로 확인.',
        '',
        '오류 수정 지침:',
        '- 출력된 결과를 분석하고 오류를 수정하세요.',
        '- 수행실패가 연속적으로 이어진다면 방법을 완전히 새롭게 변경.',
        '- 처리할 파일이나 폴더를 찾지 못하는 경우 있을수 있는 모든 방법으로 다방면으로 파일의 존재를 검색하라.',
        '',
        !solution ? '' : `다음 진행을 위한 참고지침:`,
        !solution ? '' : `${solution}`,
        '',
        '미션 완수 선고 지침:',
        `- 선고는 보수적으로 논리적으로 판단하고 판단의 근거가 충분할 때에 내리세요.`,
        `- 미션이 완료되었다고 판단되면, 정확히 '${endSign}'를 출력하는 console.log('${endSign}') 코드 한줄만 작성하세요.`,
        '',
    ].join('\n').trim(),
    evaluationPrompt: (outputPreview, endSign, solution) => [
        '네가 제공해준 코드를 실행했다!!',
        '코드 실행 결과가 미션 완료를 나타내는지 평가하고 다음 작업을 수행할 코드를 작성해 주세요.',
        '코드 실행 결과를 면밀히 분석하고 결과에서 의미를 찾고 그 의미에 따라서 다음 작업을 수행할 코드를 작성해.',
        '',
        '',
        `**평가 근거가 불충분하면**, 추가 증거를 수집하여 출력하는 코드 작성해.`,
        `**미션이 실패했다고 판단되면**, 올바르게 미션을 완수하는 새로운 코드를 작성해.`,
        '',
        !solution ? '' : `다음 진행을 위한 참고지침:`,
        !solution ? '' : `${solution}`,
        '',
        'INSTRUCTION:',
        '- 앞선 코드의 수행에 따른 결과 누적되어있음을 반드시 명심해서 코드를 작성해.',
        '- 이전 과정과 동일한 일을 수행하는 코드 생성 금지',
        `- 미션이 완료되었다고 판단되면, 정확히 '${endSign}'를 출력하는 console.log('${endSign}') 코드 한줄만 작성하세요.`,
        '',
        '코드 실행 결과:',
        '```shell',
        `$ node code.js`,
        `${outputPreview}`,
        '```',
        '',
        '코드 실행 결과를 면밀히 분석하고 결과에서 의미를 찾고 그 의미에 따라서 다음 작업을 수행할 코드를 작성해.',

    ].join('\n').trim(),
};

const highlightCode = (code) => {
    return highlight(code, {
        language: 'javascript',
        theme: {
            keyword: chalk.blue,
            string: chalk.green,
            number: chalk.yellow,
            comment: chalk.gray,
            function: chalk.magenta
        }
    });
};

// 스피너 생성 함수
const createSpinner = (text, spinnerType = 'dots') => {
    const spinner = ora({
        text,
        color: 'cyan',
        spinner: spinnerType,
        stream: process.stdout // 명시적으로 출력 스트림 지정
    }).start();

    // 기존 SIGINT 핸들러 제거 및 새로운 핸들러 등록
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', async () => {
        spinner.stop();
        console.log('\n작업이 사용자에 의해 중단되었습니다.');
        if (containerId) {
            spinners.docker = createSpinner('도커 컨테이너를 종료하는 중...');
            await killDockerContainer(containerId);
            if (spinners.docker) {
                spinners.docker.succeed('도커 컨테이너가 종료되었습니다.');
            }
        }

        process.exit(1);
    });

    return spinner;
};

export async function solveLogic({ PORT, server, multiLineMission, dataSourcePath, dataOutputPath }) {
    const processTransactions = [];
    function makeRealTransaction(multiLineMission, type, whatdidwedo, whattodo) {
        let realTransactions = [];
        for (let i = 0; i < processTransactions.length; i++) {
            const role = processTransactions[i].class === 'output' ? 'user' : 'assistant';
            const code = processTransactions[i].class === 'code' ? processTransactions[i].data : null;
            let output = processTransactions[i].class === 'output' ? processTransactions[i].data : null;
            // const outputPreview = result.output.length > 1024
            //     ? result.output.substring(0, 1024) + '...(output is too long)'
            //     : result.output;
            if (output) {
                output = output.length > 1024
                    ? output.substring(0, 1024) + '\n\n...(output is too long)'
                    : output;
            }

            let data = {
                role,
                content: (role === 'user' ? [
                    'Output of the Execution',
                    '```shell',
                    `$ node code.js`,
                    output,
                    '```',
                ] : [
                    'Code to execute',
                    '```javascript',
                    code,
                    '```',
                ]).join('\n'),
            };
            realTransactions.push(data);
        }
        if (realTransactions.length === 0) throw new Error('No transactions found');
        if (realTransactions[realTransactions.length - 1].role !== 'user') throw new Error('Last transaction is not user');
        if (realTransactions.length > 1) realTransactions[0].content = 'make the first code to do';
        realTransactions[realTransactions.length - 1] = makeCodePrompt(multiLineMission, type, whatdidwedo, whattodo);
        return realTransactions;
    }
    function makeCodePrompt(mission, type, whatdidwedo, whattodo) {

        let output = processTransactions.at(-1).data;
        if (output) {
            output = output.length > 1024
                ? output.substring(0, 1024) + '\n\n...(output is too long)'
                : output;
        }

        const last = (
            processTransactions.at(-1).data !== null ?
                [
                    'Output of the Execution',
                    '```',
                    output,
                    '```',
                    '',
                ] : []
        );
        if (type === 'coding') {
            return {
                role: "user",
                content: [
                    '',
                    `TASK TO DO:`,
                    `${whattodo.split('\n').join(' ')}`,
                    '',
                    `DID SO FAR:`,
                    `${whatdidwedo}`,
                    '',
                    ...last,
                    '',
                    'INSTRUCTION',
                    '- **단 한가지 일**만 수행.',
                    '- 앞선 과정에서 수행한 일은 반복하지 말아.',
                    '- 코드는 단일 JavaScript 파일로 완전하고 실행 가능해야 합니다.',
                    '- 진행 단계마다 `console.log`를 사용하여 상태값과 진행상황을 출력하세요.',
                    // '- 반복적 출력은 4회까지만 출력하고 그 이후는 출력하지 않아.',
                    '- 작업을 수행하는 에이전트를 위해 근거가 되는 모든 결과를 출력하세요.',
                    '- 작업 성공여부를 판단하기 위한 근거를 모든 코드 수행 라인마다 출력하세요.',
                    '- 시각화 처리가 필요한 경우는 html,css,js 웹페이지형태로 시각화 결과물을 생성하세요.',
                    '- 이미지 처리가 필요한 경우는 sharp 라이브러리를 사용하세요.',
                    '- 쉘 명령어를 실행할 때는 child_process의 spawnSync를 사용하세요.',
                    '- 선택적인 작업은 생략합니다.',
                    '',
                    'OUTPUT',
                    '```javascript',
                    'code...',
                    '```',
                    '',
                ].join('\n'),
            };
        } else if (type === 'evaluation') {
            return {
                role: "user",
                content: [
                    ...last,
                    '',
                    '지금까지 수행된 작업의 출력 결과와 기록을 분석하여 미션이 완료되었는지 엄격하게 판단하세요.',
                    '',
                    `MISSION: "${mission}"`,
                    '',
                    '이 작업으로 미션이 완전히 처리되었다면 "ENDOFMISSION"을 출력하고, 그렇지 않다면 "NOTSOLVED"를 출력하세요.',
                    '',
                    'INSTRUCTION',
                    '- 미션 완료판정은 판정을 위한 근거가 충분할 때에만 내리세요.',
                    '- 미션 완료 판단을 위해서는 명확하고 충분한 근거가 필요합니다.',
                    '- 완벽하게 확실한 경우에만 완료되었다고 판단해야 합니다.',
                    '- 업무의 중대성을 고려하여 보수적이고 엄격한 기준으로 평가해야 합니다.',


                    // '- 미션 완료가 되었다는것을 판단한 근거가 부족하면 완료되지 않았다고 판단해야 합니다.',
                    // '- 조금이라도 의심스러운 부분이 있으면 완료되지 않았다고 판단해야 합니다.',
                    // '- 이 업무는 매우 중대한 업무이므로 최대한 보수적이고 엄격하게 평가해야 합니다.',
                    '- "ENDOFMISSION" 또는 "NOTSOLVED" 둘중에 하나만 응답하세요',
                    '',
                    'OUTPUT',
                    '```',
                    '{{ENDOFMISSION|NOTSOLVED}}',
                    '```',
                ].join('\n'),
            };
        } else if (type === 'whatdidwedo') {
            return {
                role: "user",
                content: [
                    ...last,
                    '',
                    `MISSION: "${mission}"`,
                    '',
                    '인공지능 에이전트로써 지금까지 수행한 작업을 요약해서 알려줘.',
                    '',
                    '작성 지침:',
                    '- 핵심적인 내용만 짧게 작성해.',
                    '- 핵심적 담백한 표현만 사용해.',
                    '- 코드는 포함하지 마세요.',
                    // '- 자세한 내용을 한 문장으로 작성해.',
                ].join('\n'),
            };
        } else if (type === 'whattodo') {
            return {
                role: "user",
                content: [
                    '바로 직후 다음으로 수행할 **오직 절대로 딱 하나의** 작업이 무엇인지 말해!',
                    '',
                    '',
                    ...last,
                    '',
                    `MISSION: "${mission}"`,
                    '',
                    'INSTRUCTION:',
                    '- 미션과 지금까지의 진행 상황을 고려하여 다음으로 해야 할 단 한 가지 작업만 제공하세요.',
                    '- 해야할 일을 논리적으로 판단하세요.',
                    '- 선택적인 작업은 생략합니다.',
                    '- 코드 포함하지 마세요.',
                    '- 한국어로 한 문장만 응답하세요.',
                    '',
                    'OUTPUT',
                    '...를 할게요.',
                ].join('\n'),
            };
            return {
                role: "user",
                content: [
                    ...last,
                    `MISSION: "${mission}"`,
                    'Response the **THE ONLY ONE** task to do next step.',
                    'INSTRUCTION',
                    '- Only the core part.',
                    '- Consider the main mission and what has been done so far.',
                    '- Consider the result of the previous task.',
                    '- Optional tasks are omitted.',
                    '- Response the **THE ONLY ONE** task to do next step.',
                    '- Do not include code.',
                    '- Response only one sentence.',
                    '- Response in korean.',
                ].join('\n'),
            };
        }
    }
    let iterationCount = 0;

    try {
        if (config.useDocker) {
            const { isRunning } = await getDockerInfo();
            if (!isRunning) {
                throw new Error('도커가 실행중이지 않습니다.');
            }
            if (!(await doesDockerImageExist(config.dockerImage))) {
                throw new Error(`도커 이미지 ${config.dockerImage}가 존재하지 않습니다.`);
            }
            containerId = await runDockerContainerDemon(config.dockerImage);
        }
        let browser, page;

        // 브라우저 시작 스피너
        if (!config.useDocker) {
            spinners.browser = createSpinner('브라우저를 시작하는 중...');
            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            if (spinners.browser) {
                spinners.browser.succeed('브라우저가 시작되었습니다.');
            }

            // 페이지 로드 스피너
            spinners.page = createSpinner('웹 컨테이너를 초기화하는 중...');
            page = await browser.newPage();
            await page.goto(`http://localhost:${PORT}`);
            await page.waitForFunction(() => window.appReady === true, { timeout: 60000 });
            await page.evaluate(async () => await window._electrons.boot());
            if (spinners.page) {
                spinners.page.succeed('웹 컨테이너가 준비되었습니다.');
            }
        }

        // 데이터 임포트 스피너
        spinners.import = createSpinner('데이터를 가져오는 중...');
        if (config.useDocker) {
            await importToDocker(containerId, config.dockerWorkDir, dataSourcePath);
        } else {
            await importData(page, dataSourcePath);
        }
        if (spinners.import) {
            spinners.import.succeed('데이터를 성공적으로 가져왔습니다.');
        }

        while (iterationCount < config.maxIterations || !config.maxIterations) {
            iterationCount++;


            processTransactions.length === 0 && processTransactions.push({ class: 'output', data: null });

            let whatdidwedo = '';
            let whattodo = '';
            spinners.iter = createSpinner('다음 계획수립 중...');
            if (processTransactions.length > 1) {
                whatdidwedo = await chatCompletion(
                    'As an AI agent, analyze what has been done so far',
                    makeRealTransaction(multiLineMission, 'whatdidwedo'),
                    'whatDidWeDo'
                );
                if (whatdidwedo) whatdidwedo = whatdidwedo.split('\n').map(a => a.trim()).filter(Boolean).join('\n');
            }
            whattodo = await chatCompletion(
                "당신은 미션 완수를 위해 다음으로 해야 할 단 한 가지의 작업만을 제공하는 AI 비서입니다. 지금까지의 진행 상황과 이전 작업의 결과를 고려하세요. 코드나 불필요한 내용은 제외하고, 한국어로 한 문장만 응답하세요. 선택적인 작업은 생략합니다.",
                // 'As an AI agent, response **THE ONLY ONE** task to do next',
                makeRealTransaction(multiLineMission, 'whattodo'),
                'whatToDo'
            );
            if (whattodo) whattodo = whattodo.split('\n').map(a => a.trim()).filter(Boolean).join('\n');
            if (spinners.iter) {
                spinners.iter.succeed('다음 계획수립 완료.');
            }
            // if (whatdidwedo) console.log(boxen(whatdidwedo, {
            //     title: chalk.bold.cyan('지금까지 한 일'),
            //     titleAlignment: 'center',
            //     padding: 1,
            //     margin: 1,
            //     borderStyle: 'double',
            //     borderColor: 'cyan'
            // }));
            if (!true && whattodo) console.log(boxen(whattodo, {
                title: chalk.bold.cyan('다음으로 할 일'),
                titleAlignment: 'center',
                padding: 1,
                margin: 1,
                borderStyle: 'double',
                borderColor: 'cyan'
            }));
            if (whatdidwedo) console.log(chalk.bold.cyan(`📃${whatdidwedo}`));
            console.log(chalk.bold.yellowBright(`📌${whattodo}`));
            spinners.iter = createSpinner('AI가 코드를 생성하는 중...');
            let javascriptCode = await chatCompletion(
                prompts.systemPrompt(multiLineMission, whattodo, dataSourcePath),
                makeRealTransaction(multiLineMission, 'coding', whatdidwedo, whattodo),
                'generateCode'
            );
            if (spinners.iter) {
                spinners.iter.succeed('AI가 코드 생성을 완료했습니다');
            }
            spinners.iter = createSpinner('코드 실행을 준비하는 중...');
            javascriptCode = stripFencedCodeBlocks(javascriptCode);

            const requiredPackageNames = await getRequiredPackageNames(javascriptCode, prompts);
            if (spinners.iter) {
                spinners.iter.succeed('코드 실행을 준비했습니다.');
            }
            console.log(boxen(highlightCode(javascriptCode), {
                title: chalk.bold.cyan('Generated Code'),
                titleAlignment: 'center',
                padding: 1,
                margin: 1,
                borderStyle: 'double',
                borderColor: 'cyan'
            }));
            spinners.iter = createSpinner('코드를 실행하는 중...', 'line');
            let result;
            if (config.useDocker) {
                result = await runNodeJSCode(containerId, config.dockerWorkDir, javascriptCode, requiredPackageNames);
            } else {
                result = await runCode(page, javascriptCode, requiredPackageNames);
            }

            if (spinners.iter) {
                spinners.iter.succeed(`실행 #${iterationCount}차 완료`);
            }

            processTransactions.push({ class: 'code', data: javascriptCode });

            // 결과 출력 및 평가
            result.output = result.output.replace(/\x1b\[[0-9;]*m/g, '');
            console.log('');

            // 실행 결과를 boxen으로 감싸기
            const outputPreview = result.output.length > 1024
                ? result.output.substring(0, 1024) + '...(output is too long)'
                : result.output;

            console.log(chalk.bold.yellowBright(outputPreview));
            console.log('');





            processTransactions.push({ class: 'output', data: result.output });

            if (true) {
                spinners.iter = createSpinner('작업 검증중입니다.');
                let evaluation = await chatCompletion(
                    prompts.systemEvaluationPrompt(multiLineMission, dataSourcePath),
                    makeRealTransaction(multiLineMission, 'evaluation'),
                    'evaluateCode'
                );
                if (spinners.iter) spinners.iter.succeed(`작업검증완료`);
                evaluation = evaluation.replace(/[^A-Z]/g, '');
                if ((evaluation || '').toUpperCase().trim().indexOf('ENDOFMISSION') !== -1) break;
            }
        }

        console.log('Mission solved');

        // 데이터 내보내기 스피너
        spinners.export = createSpinner('결과를 저장하는 중...');
        if (config.useDocker) {
            await exportFromDocker(containerId, config.dockerWorkDir, dataOutputPath);
        } else {
            await exportData(page, dataSourcePath, dataOutputPath);
        }
        if (spinners.export) {
            spinners.export.succeed('결과가 성공적으로 저장되었습니다.');
        }

        // 정리 작업 스피너
        spinners.cleanup = createSpinner('정리 작업을 수행하는 중...');
        if (browser) await browser.close();
        server.close();
        if (spinners.cleanup) {
            spinners.cleanup.succeed('모든 작업이 완료되었습니다.');
            console.log(chalk.green(`결과물이 저장된 경로: ${chalk.bold(dataOutputPath)}`));
        }
    } catch (err) {
        // 현재 실행 중인 모든 스피너 중지
        Object.values(spinners).forEach(spinner => {
            if (spinner && spinner.isSpinning) {
                spinner.fail('작업이 중단되었습니다.');
            }
        });
        console.error('오류가 발생했습니다:', err);
        console.error('오류가 발생했습니다:', err.message);
        process.exit(1);
    }
    finally {
        if (containerId) {
            spinners.docker = createSpinner('도커 컨테이너를 종료하는 중...');
            await killDockerContainer(containerId);
            if (spinners.docker) {
                spinners.docker.succeed('도커 컨테이너가 종료되었습니다.');
            }
        }
    }
}
