// @vitest-environment jsdom
/**
 * 接入指南页面行为（phase: clklog-analytics-onboarding-v2，PRD O-2/O-3）。
 *
 * 断言两条用户可见路径：已实测条目点开是**文档抽屉**（含代码块与常见问题），
 * 未适配条目点开是「暂未开发」提示，且不泄漏任何文档内容。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import OnboardingPage from '../../pages/Meta/OnboardingPage';
import { useProjectStore } from '../../stores/project.store';

beforeEach(() => {
  localStorage.setItem('clklog-analytics-project', 'clklogapp');
  useProjectStore.setState({ currentProject: 'clklogapp' });
});

describe('接入指南页面', () => {
  it('渲染接入参数与三组 SDK 入口', async () => {
    render(<OnboardingPage />);

    expect(await screen.findByText('接入参数')).toBeTruthy();
    expect(screen.getByText('客户端 SDK')).toBeTruthy();
    expect(screen.getByText('服务端 SDK')).toBeTruthy();
    expect(screen.getByText('其他接入方式')).toBeTruthy();
    expect(screen.getByText('项目 token')).toBeTruthy();
    // 状态标签只在文档抽屉里出现（卡片上是干净的入口列表，用户要求）
    expect(screen.queryByText('已实测')).toBeNull();
    expect(screen.queryByText('语言级已实测')).toBeNull();
    expect(screen.queryByText('暂未开发')).toBeNull();
  });

  it('点击已实测的 PHP → 打开文档抽屉（有步骤、代码与常见问题）', async () => {
    render(<OnboardingPage />);

    await userEvent.click(await screen.findByTestId('sdk-php'));

    expect(await screen.findByText('PHP 接入文档')).toBeTruthy();
    expect(screen.getByText('1. 前置条件')).toBeTruthy();
    expect(screen.getAllByText('复制').length).toBeGreaterThan(0);
    expect(screen.getByText(/常见问题/)).toBeTruthy();
    // 抽屉里保留状态标签，并提供「下载演示工程」按钮（指向随产物发布的 zip）
    expect(screen.getByText('已实测')).toBeTruthy();
    const download = screen.getByTestId('demo-download-php');
    expect(download.getAttribute('href')).toContain('sdk-demos/php.zip');
  });

  it('点击未适配的 Unreal → 提示「暂未开发」，不展示步骤或代码', async () => {
    render(<OnboardingPage />);

    await userEvent.click(await screen.findByTestId('sdk-unreal'));

    expect(await screen.findByText('Unreal Engine：暂未开发')).toBeTruthy();
    expect(screen.getByText(/可以先用「其他接入方式 → HTTP \/ RESTful API」/)).toBeTruthy();
    expect(screen.queryByText('1. 前置条件')).toBeNull();
    expect(screen.queryByText(/常见问题/)).toBeNull();
  });

  it('切换项目后 App_ID / 项目名称 / 示例里的 project 同步变化（回归：曾一直显示 clklogapp）', async () => {
    render(<OnboardingPage />);
    expect(await screen.findByText('接入参数')).toBeTruthy();
    // 初始为 clklogapp（项目名 + App_ID 两处）
    expect(screen.getAllByText('clklogapp').length).toBeGreaterThanOrEqual(2);

    // 切换到 default 项目（等价于左下角项目切换器）
    await act(async () => {
      useProjectStore.setState({ currentProject: 'default' });
    });

    // 项目名 + App_ID 两处都变
    expect((await screen.findAllByText('default')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('clklogapp')).toBeNull();
    // curl 示例里的 project 也要跟着变
    expect(screen.getByText(/--data-urlencode 'project=default'/)).toBeTruthy();
  });

  it('接入前必读给出协议三要素与编码示例（含 200 陷阱说明）', async () => {
    render(<OnboardingPage />);

    expect(await screen.findByText('接入前必读')).toBeTruthy();
    expect(screen.getByText(/HTTP 仍返回 200 但数据静默丢失/)).toBeTruthy();
    expect(screen.getAllByText(/base64/i).length).toBeGreaterThan(0);
  });
});
