import { describe, expect, it } from "vitest";
import { constrainAgentRequest, requestAllowsMutation } from "./agent-request-boundary";
import type { AgentLoopToolCall } from "./agent-loop";
const call=(tool: AgentLoopToolCall["tool"],args:Record<string,unknown>):AgentLoopToolCall=>({action:"tool_call",tool,arguments:args,reason:"model proposal"});
describe("agent request boundaries",()=>{
 it("cannot escalate a setting read to a write, including after a failed read",()=>{
  expect(constrainAgentRequest(call("console.command",{command:"whitelist on"}),"检查白名单开关和正版验证开关，各自现在是什么值。","paper")).toMatchObject({tool:"config.inspect",arguments:{path:"server.properties",keys:["white-list","online-mode"]}});
  expect(constrainAgentRequest(call("instance.restart",{target:"instance"}),"查最近的错误日志","paper")).toMatchObject({action:"cannot_proceed"});
 });
 it.each(["把模拟距离设成 5，保存后再查一次。","把视距恢复到 10，然后读回这个值。","安装 LuckPerms"])("retains real write authorization: %s",m=>expect(requestAllowsMutation(m)).toBe(true));
 it.each(["搜索 spark 官方文档中如何开始和停止性能采样，只查文档，不执行采样。","查适配版本，只查版本和下载来源，暂时不要安装。"])("keeps documentation and lookup requests read only: %s",m=>expect(requestAllowsMutation(m)).toBe(false));
 it("uses the configuration owner while preserving an explicit user path",()=>{
  expect(constrainAgentRequest(call("config.inspect",{path:"config/paper-world-defaults.conf",keys:["view-distance","simulation-distance"]}),"恢复视距和模拟距离","paper")).toMatchObject({arguments:{path:"server.properties"}});
  expect(constrainAgentRequest(call("config.inspect",{path:"staging/paper.conf",keys:["online-mode"]}),"读取 staging/paper.conf 的 online-mode","paper")).toMatchObject({arguments:{path:"staging/paper.conf"}});
 });
 it("preserves subject AND alternatives in log queries",()=>{
  const d=constrainAgentRequest(call("logs.query",{window_minutes:10,max_lines:200,filter_query:{groups:[{all_of:[],any_of:["client_connection","timeout"]}]}}),"查最近十分钟有没有玩家连接被拒绝或超时的记录。","paper");
  expect(d).toMatchObject({arguments:{filter_query:{groups:[{all_of:["client_connection"],any_of:["connection_failure","timeout"]}]}}});
 });
 it("normalizes equivalent property writes before replay detection",()=>{
  expect(constrainAgentRequest(call("config.patch",{path:"server.properties",patch:[{op:"replace",key:"view-distance",value:7}]}),"视距设成7","paper")).toMatchObject({arguments:{patch:[{value:"7"}]}});
 });
});
