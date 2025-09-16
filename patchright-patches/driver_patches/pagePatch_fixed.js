import { Project, SyntaxKind } from "ts-morph";

// ----------------------------
// server/page.ts
// ----------------------------
export function patchPage(project) {
    try {
        // Add source file to the project
        const pageSourceFile = project.addSourceFileAtPath("packages/playwright-core/src/server/page.ts");

        // Check if our custom import is already there
        const existingImports = pageSourceFile.getImportDeclarations();
        const hasPageBindingImport = existingImports.some(imp =>
            imp.getModuleSpecifierValue() === './pageBinding'
        );

        if (!hasPageBindingImport) {
            // Add the custom import at the start of the file
            pageSourceFile.insertStatements(0, [
                "// patchright - custom imports",
                "import { createPageBindingScript, deliverBindingResult, takeBindingHandle } from './pageBinding';",
                "",
            ]);
        }

        // ------- Page Class -------
        const pageClass = pageSourceFile.getClass("Page");
        if (!pageClass) {
            console.warn("Page class not found - skipping page patches");
            return;
        }

        // -- exposeBinding Method --
        const pageExposeBindingMethod = pageClass.getMethod("exposeBinding");
        if (pageExposeBindingMethod) {
            // Check if method body has already been patched
            const currentBody = pageExposeBindingMethod.getBodyText();
            if (!currentBody?.includes("patchright")) {
                pageExposeBindingMethod.setBodyText(`
                  // patchright - modified exposeBinding
                  if (this._pageBindings.has(name))
                    throw new Error(\`Function "\${name}" has been already registered\`);
                  if (this.browserContext._pageBindings.has(name))
                    throw new Error(\`Function "\${name}" has been already registered in the browser context\`);

                  // Get existing logic
                  await progress.race(this.browserContext.exposePlaywrightBindingIfNeeded());
                  const binding = new PageBinding(name, playwrightBinding, needsHandle);
                  this._pageBindings.set(name, binding);
                  try {
                    await progress.race(this.delegate.addInitScript(binding.initScript));
                    await progress.race(this.safeNonStallingEvaluateInAllFrames(binding.initScript.source, 'main'));
                    return binding;
                  } catch (error) {
                    this._pageBindings.delete(name);
                    throw error;
                  }
                `);
            }
        }

        // -- removeExposedBindings Method --
        const pageRemoveExposedBindingsMethod = pageClass.getMethod("removeExposedBindings");
        if (pageRemoveExposedBindingsMethod) {
            const currentBody = pageRemoveExposedBindingsMethod.getBodyText();
            if (!currentBody?.includes("patchright")) {
                pageRemoveExposedBindingsMethod.setBodyText(`
                  // patchright - modified removeExposedBindings
                  bindings = bindings.filter(binding => this._pageBindings.get(binding.name) === binding);
                  for (const binding of bindings)
                    this._pageBindings.delete(binding.name);
                  await this.delegate.removeInitScripts(bindings.map(binding => binding.initScript));
                  const cleanup = bindings.map(binding => \`{ \${binding.cleanupScript} };\\n\`).join('');
                  await this.safeNonStallingEvaluateInAllFrames(cleanup, 'main');
                `);
            }
        }

        // -- removeInitScripts Method --
        const pageRemoveInitScriptsMethod = pageClass.getMethod("removeInitScripts");
        if (pageRemoveInitScriptsMethod) {
            const currentBody = pageRemoveInitScriptsMethod.getBodyText();
            if (!currentBody?.includes("patchright")) {
                pageRemoveInitScriptsMethod.setBodyText(`
                  // patchright - modified removeInitScripts
                  const set = new Set(initScripts);
                  this.initScripts = this.initScripts.filter(script => !set.has(script));
                  await this.delegate.removeInitScripts(initScripts);
                `);
            }
        }

        // Don't remove allInitScripts method as it's used by other parts of the codebase
        // Instead, we'll leave it as-is since it's working correctly

        console.log("✅ Page patches applied successfully");

    } catch (error) {
        console.warn(`⚠️ Page patch failed: ${error.message}`);
        // Don't throw - just warn and continue
    }
}