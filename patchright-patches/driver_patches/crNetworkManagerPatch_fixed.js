import { Project, SyntaxKind } from "ts-morph";

// ----------------------------
// server/chromium/crNetworkManager.ts
// ----------------------------
export function patchCRNetworkManager(project) {
    try {
        // Add source file to the project
        const crNetworkManagerSourceFile = project.addSourceFileAtPath(
            "packages/playwright-core/src/server/chromium/crNetworkManager.ts",
        );

        // ------- InterceptedRequest Class -------
        const interceptedRequestClass = crNetworkManagerSourceFile.getClass("InterceptedRequest");

        if (!interceptedRequestClass) {
            console.warn("InterceptedRequest class not found - skipping this patch");
            return;
        }

        // -- Constructor --
        const constructorDeclarations = interceptedRequestClass.getConstructors();
        if (constructorDeclarations.length === 0) {
            console.warn("Constructor not found in InterceptedRequest class - skipping this patch");
            return;
        }

        const constructorDeclaration = constructorDeclarations[0];

        // Check if constructor already has the parameters we want to add
        const existingParams = constructorDeclaration.getParameters().map(p => p.getName());

        if (!existingParams.includes("page")) {
            // Get current parameters and add the new `page` parameter
            const parameters = constructorDeclaration.getParameters();
            constructorDeclaration.insertParameter(parameters.length, {
                name: "page",
                type: "any" // We'll use any to avoid type issues
            });
        }

        if (!existingParams.includes("networkId")) {
            constructorDeclaration.insertParameter(constructorDeclaration.getParameters().length, {
                name: "networkId",
                type: "any"
            });
        }

        if (!existingParams.includes("sessionManager")) {
            constructorDeclaration.insertParameter(constructorDeclaration.getParameters().length, {
                name: "sessionManager",
                type: "any"
            });
        }

        // Check if class already has the properties we want to add
        const existingProperties = interceptedRequestClass.getProperties().map(p => p.getName());

        if (!existingProperties.includes("_page")) {
            // Add the _page property
            interceptedRequestClass.insertProperty(0, {
                name: "_page",
                type: "any",
                hasQuestionToken: true
            });
        }

        if (!existingProperties.includes("_networkId")) {
            interceptedRequestClass.insertProperty(0, {
                name: "_networkId",
                type: "any",
                hasQuestionToken: true
            });
        }

        if (!existingProperties.includes("_sessionManager")) {
            interceptedRequestClass.insertProperty(0, {
                name: "_sessionManager",
                type: "any",
                hasQuestionToken: true
            });
        }

        // Modify the constructor's body to include the new assignments
        const constructorBody = constructorDeclaration.getBody();
        if (constructorBody) {
            const existingStatements = constructorBody.getStatements().map(s => s.getText());

            const statementsToAdd = [
                "this._page = page;",
                "this._networkId = networkId;",
                "this._sessionManager = sessionManager;"
            ];

            for (const statement of statementsToAdd) {
                if (!existingStatements.some(existing => existing.includes(statement))) {
                    constructorBody.addStatements(statement);
                }
            }
        }

        console.log("✅ CR network manager patches applied successfully");

    } catch (error) {
        console.warn(`⚠️ CR network manager patch failed: ${error.message}`);
        // Don't throw - just warn and continue
    }
}