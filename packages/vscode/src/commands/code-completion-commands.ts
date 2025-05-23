import * as vscode from 'vscode'
import axios from 'axios'
import { make_api_request } from '../helpers/make-api-request'
import { code_completion_instruction } from '../constants/instructions'
import { FilesCollector } from '../helpers/files-collector'
import { ApiToolsSettingsManager } from '../services/api-tools-settings-manager'
import { Logger } from '../helpers/logger'
import he from 'he'

async function build_completion_payload(params: {
  document: vscode.TextDocument
  position: vscode.Position
  file_tree_provider: any
  open_editors_provider?: any
  suggestions?: string
}): Promise<string> {
  const document_path = params.document.uri.fsPath
  const text_before_cursor = params.document.getText(
    new vscode.Range(new vscode.Position(0, 0), params.position)
  )
  const text_after_cursor = params.document.getText(
    new vscode.Range(
      params.position,
      params.document.positionAt(params.document.getText().length)
    )
  )

  const files_collector = new FilesCollector(
    params.file_tree_provider,
    params.open_editors_provider
  )

  const context_text = await files_collector.collect_files({
    exclude_path: document_path
  })

  const payload = {
    before: `<files>\n${context_text}<file path="${vscode.workspace.asRelativePath(
      params.document.uri
    )}">\n<![CDATA[\n${text_before_cursor}`,
    after: `${text_after_cursor}\n]]>\n</file>\n</files>`
  }

  const instructions = `${code_completion_instruction}${
    params.suggestions ? ` Follow suggestions: ${params.suggestions}` : ''
  }`

  return `${instructions}\n${payload.before}<missing text>${payload.after}\n${instructions}`
}

/**
 * Show inline completion using Inline Completions API
 */
async function show_inline_completion(params: {
  editor: vscode.TextEditor
  position: vscode.Position
  completion_text: string
}) {
  const document = params.editor.document
  const controller = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    {
      provideInlineCompletionItems: () => {
        const item = {
          insertText: params.completion_text,
          range: new vscode.Range(params.position, params.position)
        }
        return [item]
      }
    }
  )

  // Listen for text document changes that would indicate completion acceptance
  const change_listener = vscode.workspace.onDidChangeTextDocument(
    async (e) => {
      if (e.document === document) {
        await vscode.commands.executeCommand(
          'editor.action.formatDocument',
          document.uri
        )
        change_listener.dispose()
      }
    }
  )

  // Trigger the inline completion UI
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')

  // Dispose after a timeout or some event (optional cleanup)
  setTimeout(() => {
    controller.dispose()
    change_listener.dispose() // Make sure to clean up the listener if not used
  }, 10000)
}

// Core function that contains the shared logic
async function perform_code_completion(params: {
  file_tree_provider: any
  open_editors_provider: any
  context: vscode.ExtensionContext
  with_suggestions: boolean
  auto_accept: boolean
}) {
  const api_tool_settings_manager = new ApiToolsSettingsManager(params.context)

  const code_completions_settings =
    api_tool_settings_manager.get_code_completions_settings()

  if (!code_completions_settings.provider) {
    vscode.window.showErrorMessage(
      'API provider is not specified for Code Completions tool. Go to Gemini Coder panel -> API Tools tab -> Configure Tools.'
    )
    Logger.warn({
      function_name: 'perform_code_completion',
      message: 'API provider is not specified for Code Completions tool.'
    })
    return
  } else if (!code_completions_settings.model) {
    vscode.window.showErrorMessage(
      'Model is not specified for Code Completions tool. Go to Gemini Coder panel -> API Tools tab -> Configure Tools.'
    )
    Logger.warn({
      function_name: 'perform_code_completion',
      message: 'Model is not specified for Code Completions tool.'
    })
    return
  }

  const connection_details =
    api_tool_settings_manager.provider_to_connection_details(
      code_completions_settings.provider
    )

  let suggestions: string | undefined
  if (params.with_suggestions) {
    suggestions = await vscode.window.showInputBox({
      placeHolder: 'Enter suggestions',
      prompt: 'E.g. include explanatory comments'
    })

    if (suggestions === undefined) {
      return
    }
  }

  if (!connection_details.api_key) {
    vscode.window.showErrorMessage(
      'API key is missing. Please add it in the settings.'
    )
    return
  }

  const editor = vscode.window.activeTextEditor
  if (editor) {
    const cancel_token_source = axios.CancelToken.source()
    const document = editor.document
    const position = editor.selection.active

    const content = await build_completion_payload({
      document,
      position,
      file_tree_provider: params.file_tree_provider,
      open_editors_provider: params.open_editors_provider,
      suggestions
    })

    const messages = [
      {
        role: 'user',
        content
      }
    ]

    const body = {
      messages,
      model: code_completions_settings.model,
      temperature: code_completions_settings.temperature || 0
    }

    Logger.log({
      function_name: 'perform_fim_completion',
      message: 'Prompt:',
      data: content
    })

    const cursor_listener = vscode.workspace.onDidChangeTextDocument(() => {
      cancel_token_source.cancel('User moved the cursor, cancelling request.')
    })

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Waiting for code completion...',
        cancellable: true
      },
      async (_, token) => {
        token.onCancellationRequested(() => {
          cancel_token_source.cancel('User cancelled the operation')
        })

        try {
          const completion = await make_api_request(
            connection_details.endpoint_url,
            connection_details.api_key,
            body,
            cancel_token_source.token
          )

          if (completion) {
            const match = completion.match(
              /<replacement>([\s\S]*?)<\/replacement>/i
            )
            if (match && match[1]) {
              const decoded_completion = he.decode(match[1].trim())
              if (params.auto_accept) {
                await editor.edit((editBuilder) => {
                  editBuilder.insert(position, decoded_completion)
                })
                await vscode.commands.executeCommand(
                  'editor.action.formatDocument',
                  document.uri
                )
              } else {
                await show_inline_completion({
                  editor,
                  position,
                  completion_text: decoded_completion
                })
              }
            }
          }
        } catch (err: any) {
          Logger.error({
            function_name: 'perform_fim_completion',
            message: 'Completion error',
            data: err
          })
        } finally {
          cursor_listener.dispose()
        }
      }
    )
  }
}

export function code_completion_commands(
  file_tree_provider: any,
  open_editors_provider: any,
  context: vscode.ExtensionContext
) {
  return [
    vscode.commands.registerCommand('codeWebChat.codeCompletion', async () =>
      perform_code_completion({
        file_tree_provider,
        open_editors_provider,
        context,
        with_suggestions: false,
        auto_accept: false
      })
    ),
    vscode.commands.registerCommand(
      'codeWebChat.codeCompletionAutoAccept',
      async () =>
        perform_code_completion({
          file_tree_provider,
          open_editors_provider,
          context,
          with_suggestions: false,
          auto_accept: true
        })
    ),
    vscode.commands.registerCommand(
      'codeWebChat.codeCompletionWithSuggestions',
      async () =>
        perform_code_completion({
          file_tree_provider,
          open_editors_provider,
          context,
          with_suggestions: true,
          auto_accept: false
        })
    ),
    vscode.commands.registerCommand(
      'codeWebChat.codeCompletionWithSuggestionsAutoAccept',
      async () =>
        perform_code_completion({
          file_tree_provider,
          open_editors_provider,
          context,
          with_suggestions: true,
          auto_accept: true
        })
    )
  ]
}
