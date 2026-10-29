#!/usr/bin/env python3
"""MCP stdio adapter. Git, runtime inspector and preview debug tools all run inside the Creator plugin."""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys

VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26')
LIMIT = 128 * 1024
EXTENSION = 'cocos-git-desk'
EXTENSION_DIR = 'extensions/' + EXTENSION
CONFIG_FILE = 'git-desk.config.json'
STATIC_DIR = Path(__file__).resolve().parents[1] / 'static'
# Same rule as src/config.ts enabledCatalogues: core, inspector and bridge are always listed (bridge
# tools fail clearly without a page bridge); i18n only when git-desk.config.json sets i18n.keyPattern.
CATALOGUES = ('core', 'inspector', 'bridge', 'i18n')
OFFLINE = ('Git Desk in Cocos Creator is not reachable: {reason}. Creator may not be running, the project may not be open, '
           'or the ' + EXTENSION + ' extension may be disabled or reloading. Open the project in Cocos Creator, make sure the '
           'extension is enabled (reload it in the Extension Manager if needed), then call again; do not retry unconfirmed writes')


def i18n_enabled(project):
    """True when the project's git-desk.config.json sets a non-empty i18n.keyPattern; a missing or invalid file means no."""
    try:
        config = json.loads((project / CONFIG_FILE).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return False
    section = config.get('i18n') if isinstance(config, dict) else None
    pattern = section.get('keyPattern') if isinstance(section, dict) else None
    return isinstance(pattern, str) and pattern != ''


def enabled_catalogues(project):
    return [name for name in CATALOGUES if name != 'i18n' or i18n_enabled(project)]


def load_tools(project, static_dir=STATIC_DIR):
    tools, seen = [], set()
    for name in enabled_catalogues(project):
        entries = json.loads((static_dir / ('mcp-tools.' + name + '.json')).read_text(encoding='utf-8'))
        if not isinstance(entries, list):
            raise ValueError('Tool catalogue is not a list: mcp-tools.' + name + '.json')
        for tool in entries:
            if not isinstance(tool, dict) or not isinstance(tool.get('name'), str) or tool['name'] in seen:
                raise ValueError('Duplicate or invalid tool in mcp-tools.' + name + '.json')
            seen.add(tool['name'])
            tools.append(tool)
    return tools


def server_version():
    try:
        version = json.loads((STATIC_DIR.parent / 'package.json').read_text(encoding='utf-8')).get('version')
    except (OSError, ValueError, AttributeError):
        version = None
    return version if isinstance(version, str) and version else '0.0.0'


def invoke(project, name, arguments):
    filename = project / EXTENSION_DIR / '.cache' / 'agent-connection.json'
    try:
        info = filename.lstat()
    except FileNotFoundError:
        raise ValueError(OFFLINE.format(reason='connection file not found: ' + str(filename)))
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
        raise ValueError('Invalid Creator connection file')
    if os.name != 'nt' and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise ValueError('Creator connection file must be private to this user')
    connection = json.loads(filename.read_text(encoding='utf-8'))
    if connection.get('schema') != 1 or Path(connection.get('project', '')).resolve() != project:
        raise ValueError('Creator connection belongs to a different project')
    port, token = connection.get('port'), connection.get('token')
    if type(port) is not int or not 0 < port < 65536 or not isinstance(token, str) or not re.fullmatch('[a-f0-9]{64}', token):
        raise ValueError('Invalid Creator connection metadata')
    body = json.dumps({'name': name, 'arguments': arguments}, ensure_ascii=False).encode('utf-8')
    if len(body) > LIMIT:
        raise ValueError('Tool request too large')
    client = http.client.HTTPConnection('127.0.0.1', port, timeout=120)
    try:
        try:
            client.request('POST', '/rpc', body, {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = client.getresponse()
        except TimeoutError:
            raise ValueError('Creator did not answer within 120 s; the operation may still be running. Check git_desk_task_status before retrying any write')
        except OSError as error:
            raise ValueError(OFFLINE.format(reason='cannot connect to port %d (%s)' % (port, error)))
        raw = response.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError('Tool response too large; inspect task status before any retry')
        result = json.loads(raw)
        if response.status != 200:
            raise ValueError(result.get('error', 'Creator rejected request') + '; do not retry uncertain writes')
        return result
    finally:
        client.close()


def serve(project, source=None, output=None):
    source = source or sys.stdin.buffer
    output = output or sys.stdout
    tools = load_tools(project)
    catalogue = {tool['name']: tool for tool in tools}
    initialized = False
    ready = False
    protocol = VERSIONS[0]
    while True:
        line = source.readline(LIMIT + 1)
        if not line:
            return
        if len(line) > LIMIT:
            return
        message = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' or not isinstance(message.get('method'), str):
                raise ValueError('Invalid JSON-RPC request')
            method = message['method']
            if 'id' not in message:
                if method == 'notifications/initialized' and initialized:
                    ready = True
                continue
            params = message.get('params', {})
            if not isinstance(params, dict):
                raise ValueError('params must be an object')
            if method == 'initialize':
                if initialized or not isinstance(params.get('protocolVersion'), str):
                    raise ValueError('Invalid initialization')
                initialized = True
                protocol = params['protocolVersion'] if params['protocolVersion'] in VERSIONS else VERSIONS[0]
                result = {'protocolVersion': protocol, 'capabilities': {'tools': {}}, 'serverInfo': {'name': EXTENSION, 'version': server_version()}, 'instructions': 'Read capabilities first. Scope tasks record observations, not authorship. Review full plans and human authorization before execute. Never retry uncertain writes; inspect task status. runtime_inspector_* and browser_debug_* tools need the Creator debug preview panel open; they observe the running game and never edit source files.'}
            elif method == 'ping':
                result = {}
            elif not ready:
                raise ValueError('Initialize the MCP session first')
            elif method == 'tools/list':
                if params.get('cursor'):
                    raise ValueError('Unknown cursor')
                result = {'tools': tools}
            elif method == 'tools/call':
                name, arguments = params.get('name'), params.get('arguments', {})
                if name not in catalogue or not isinstance(arguments, dict):
                    raise ValueError('Unknown tool or invalid arguments')
                try:
                    reply = invoke(project, name, arguments)
                    result = {'content': [{'type': 'text', 'text': json.dumps(reply, ensure_ascii=False)}], 'isError': reply.get('ok') is not True, 'structuredContent': reply}
                    if protocol == '2025-03-26':
                        result.pop('structuredContent')
                except Exception as error:
                    result = {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
            else:
                output.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Method not found'}}) + '\n'); output.flush()
                continue
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'result': result}
        except (ValueError, TypeError) as error:
            reply = {'jsonrpc': '2.0', 'id': message.get('id') if isinstance(message, dict) else None, 'error': {'code': -32602 if isinstance(message, dict) else -32700, 'message': str(error)}}
        output.write(json.dumps(reply, ensure_ascii=False) + '\n')
        output.flush()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    args = parser.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        serve(args.project.resolve())
    except BrokenPipeError:
        pass
