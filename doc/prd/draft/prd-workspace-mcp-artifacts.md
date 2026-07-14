# PRD — Workspace MCP Artifacts

**Status:** Draft
**Related:** [Workspace MCP](prd-workspace-mcp.md), [Shared Drives](../accepted/prd-shared-drives.md)

## Problem

An external AI client can call a workspace through MCP and ask it to create a
file, such as an Excel spreadsheet or a PDF. The client needs a simple and safe
way to receive that file.

## Goal

Let published workspace MCP skills return files created during a call.

## User story

> As an external AI client, I want to ask a workspace to create an Excel file
> and receive a link to download it.

## Requirements

- A workspace skill can create a file and upload it to a connected shared drive.
- The caller receives a safe way to download the finished file.
- The caller can access only the file created for its request.
- File access is temporary.
- Large files are retrieved separately from the skill response.
- Internal PAODO agent calls can continue to use a drive and file path.
```

## Non-goals

- Giving an external MCP client access to browse all shared-drive files.
- Sending large files directly in the skill response.
- Changing how internal PAODO agents exchange files.

## Acceptance criteria

- A caller can download an Excel or PDF file produced by a published MCP skill.
- The download link cannot be used to access another file.
- An expired link no longer works.
