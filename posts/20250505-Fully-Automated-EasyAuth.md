---
title: Fully Automated EasyAuth
date: 2025-05-05 20:00
---

When setting up Entra authentication — like configuring EasyAuth for App Services or Container Apps, or managing App Registrations and Enterprise Apps on the Entra side — official tutorials generally lean heavily on manual clicking ("click-ops") in the Azure Portal. This article demonstrates how all such clicking can be avoided by scripting the whole thing.

In this article, Terraform is used for Infrastructure as Code (IaC), PowerShell for scripting, and GitHub Actions for pipelines, but achieving the same thing using Bicep, Bash, and Azure DevOps is equally straightforward.

The code examples presented are based on the "JavaCMS" toy project, whose source code is available in its [GitHub repo](https://github.com/iotalambda/javacms/commit/fe2256177a9ed3a8c844c09ae8e64571af430a06).

## Entra resources

An `az cli` heavy, *idempotent* script is first created to set up the Entra resources — an App Registration and an Enterprise App. To begin, some variables are needed:

```powershell
# The name of the App Registration shown in Azure Portal.
# ⚠️ Replace this with your own!
$appRegName = "jcms-app"

# The name of the Key Vault instance in which secrets can be stored.
# ⚠️ Replace this with your own!
$keyVaultName = "jcms-dev-mgmt-kv"

# The name of the Service Principal used by GitHub Actions.
# ⚠️ Replace this with your own!
$githubSpName = "jcms-github"
```

A hash-set for the *redirect URIs* is also needed, ensuring they're kept updated for the App Registration and preventing duplicates:

```powershell
# ⚠️ Replace this with your own!
$redirectUris = @{ "http://localhost:3000/api/auth/callback/microsoft-entra-id" = $true }
```

Note that the hash-set includes a localhost address, allowing Entra authentication to be used even when the app is running locally. If local support isn't needed, the array can remain empty.

To keep the script idempotent — meaning running it multiple times always results in the same outcome — it first needs to be checked whether an App Registration named `$appRegName` already exists. If it does, the existing one and its redirect URIs are reused; otherwise, a new one is created:

```powershell
Write-InfoLog "Checking if app registration exists..."
$existingAppRegDetails = (az ad app list | ConvertFrom-Json) | Where-Object { $_.displayName -eq "$appRegName" }[0]
if ($existingAppRegDetails) {
    $appRegId = $existingAppRegDetails.appId
    Write-InfoLog "App registration exists. Extracting redirect uris..."
    if ($existingAppRegDetails.web.redirectUris) {
        foreach ($uri in $existingAppRegDetails.web.redirectUris) {

            # NOTE: The hash-set approach is useful here, as it prevents duplication
            #       of the initial localhost redirect URL.
            $redirectUris[$uri] = $true 
        }
        Write-InfoLog "Redirect uris extracted."
    }
    else {
        Write-InfoLog "No redirect uris."
    }
}
else {
    Write-InfoLog "App registration doesn't exist. Creating app registration..."
    $appRegId = az ad app create `
        --display-name "$appRegName" `
        --query "appId" `
        --output "tsv"
    Write-InfoLog "App registration created."
}
```

The ID of the existing/created App Registration is also stored in the `$appRegId` variable.

Whether newly created or not, the App Registration is then ensured to have the correct redirect URIs:

```powershell
Write-InfoLog "Updating redirect uris..."
az ad app update `
    --id "$appRegId" `
    --web-redirect-uris $redirectUris.Keys `
    --output "none"
Write-InfoLog "Redirect uris updated."
```

An *Identifier URI* (`api://...`) must also be configured for the App Registration. This Identifier URI globally identifies the App Registration as a resource in OAuth flows:

```powershell
Write-InfoLog "Adding identifier URI..."
az ad app update `
    --id "$appRegId" `
    --identifier-uris "api://$appRegId" `
    --output "none"
Write-InfoLog "Identifier URI added."
```

Next, *ID token issuance* is enabled, allowing the App Registration to authenticate users and issue claims about them:

```powershell
Write-InfoLog "Enabling ID tokens..."
az ad app update `
    --id "$appRegId" `
    --enable-id-token-issuance "true" `
    --output "none"
Write-InfoLog "ID tokens enabled."
```

The `User.Read` permission must be configured for the App Registration. This allows the authentication flow to request the `User.Read` scope on behalf of the app, enabling access to the user's email address and other necessary claims. The current permission list of the App Registration is retrieved, and it is ensured that permission for that scope exists in an idempotent way:

```powershell
Write-InfoLog "Getting existing permissions..."
$existingPermissions = az ad app permission list --id "$appRegId" | ConvertFrom-Json
Write-InfoLog "Existing permissions gotten."

$graphApiAppId = "00000003-0000-0000-c000-000000000000"
$userReadResourceAccessId = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"
$existingUserReadPermission = $existingPermissions | Where-Object { $_.resourceAppId -eq $graphApiAppId -and ($_.resourceAccess | Where-Object { $_.id -eq $userReadResourceAccessId }) }
if ($existingUserReadPermission) {
    Write-InfoLog "User.Read permission exists."
}
else {
    Write-InfoLog "Adding User.Read permission..."
    az ad app permission add `
        --id "$appRegId" `
        --api $graphApiAppId `
        --api-permissions "$userReadResourceAccessId=Scope" `
        --output "none"
    Write-InfoLog "User.Read permission added."
}
```

The value of `$userReadResourceAccessId` corresponds to [a "well-known" globally unique identifier of the delegated `User.Read` permission in Microsoft Graph](https://learn.microsoft.com/en-us/graph/migrate-azure-ad-graph-permissions-differences#delegated-12).

Since the example application's users belong to the current tenant, admin consent is granted to the App Registration:

```powershell
Write-InfoLog "Granting admin consent..."
az ad app permission admin-consent `
    --id "$appRegId" `
    --output "none"
Write-InfoLog "Admin consent granted."
```

Next, the Enterprise App is set up by creating one with the same ID as the App Registration:

```powershell
Write-InfoLog "Creating enterprise app..."
az ad sp create `
    --id "$appRegId" `
    --output "none"
Write-InfoLog "Enterprise app created."
```

The example application uses the Enterprise App’s *App Roles* for authorization. To enforce this, an assignment to an App Role is required:

```powershell
Write-InfoLog "Setting assignment required..."
az ad sp update `
    --id "$appRegId" `
    --set appRoleAssignmentRequired=true `
    --output "none"
Write-InfoLog "Assignment set required."
```

Later, when the application's infrastructure is set up in GitHub Actions, the Entra resources will need to be further configured using the GitHub Actions–associated Service Principal. To grant sufficient privileges, ownership of the Enterprise App is assigned to this Service Principal. First, its Object ID is retrieved:

```powershell
Write-InfoLog "Getting github service principal object id..."
$githubSpObjectId = ((az ad sp list | ConvertFrom-Json) | Where-Object { $_.displayName -eq "$githubSpName" })[0].id
Write-InfoLog "Github service principal object id gotten."
```

The Service Principal is then assigned as the owner of the Enterprise App:

```powershell
Write-InfoLog "Adding github service principal as the owner of the app..."
az ad app owner add `
    --id "$appRegId" `
    --owner-object-id "$githubSpObjectId" `
    --output "none"
Write-InfoLog "Github SP added as the owner of the app."
```

Finally, a *client secret* is created for the application to use when accessing the App Registration:

```powershell
Write-InfoLog "Creating client secret..."
$clientSecret = az ad app credential reset `
    --id "$appRegId" `
    --display-name "client-secret" `
    --years 2 `
    --query "password" `
    --output "tsv"
Write-InfoLog "Client secret created."
```

The *client secret* and the App Registration's *client ID* (which — incidentally — is equal to `$appRegId`) are stored in Key Vault, allowing easy synchronization with Azure based applications:

```powershell
Write-InfoLog "Adding client id to key vault..."
az keyvault secret set `
    --vault-name "$keyVaultName" `
    --name "jcms-entra-clientid" ` # ⚠️ Replace the secret name with your own!
    --value "$appRegId" `
    --output "none"
Write-InfoLog "Client id added to key vault."

Write-InfoLog "Adding client secret to key vault..."
az keyvault secret set `
    --vault-name "$keyVaultName" `
    --name "jcms-entra-clientsecret" ` # ⚠️ Replace the secret name with your own!
    --value "$clientSecret" `
    --output "none"
Write-InfoLog "Client secret added to key vault."
```

## IaC

The example application runs on Azure Container Apps, so next a Container App is created using Terraform (irrelevant parts removed for brevity):

```hcl
resource "azurerm_container_app" "ca_jcmsui" {
    ...
  template {
    ...
    container {
      ...
      env {
        name  = "WEBSITE_AUTH_AAD_ALLOWED_TENANTS"
        value = data.azurerm_client_config.current.tenant_id
      }
    }
  }
  secret {
    name                = "jcms-entra-clientsecret"
    key_vault_secret_id = data.azurerm_key_vault_secret.entra_clientsecret.id
  }
}
```

The `WEBSITE_AUTH_AAD_ALLOWED_TENANTS` env variable is a standard setting for EasyAuth. In the example application, access is restricted to users of the current tenant. The client secret is also synchronized from Key Vault. Since the AzureRM Terraform provider does not (*naturally*) support configuring EasyAuth, it's hacked together using `azapi` and `null_resource`s instead. First, an `authConfigs` resource is created using `azapi`:

```hcl
resource "azapi_resource" "auth_ca_jcmsui" {
  type      = "Microsoft.App/containerApps/authConfigs@2024-10-02-preview"
  name      = "current"

  # This `authConfigs` resource is a child of the Container App.
  parent_id = azurerm_container_app.ca_jcmsui.id

  body = {
    properties = {

      # The globalValidation section redirects any unauthorized users to the
      # Entra login page. The nice thing is that this process is handled entirely
      # by Azure-managed reverse proxies in front of Container Apps,
      # ensuring that unauthorized requests never reach the application itself.
      globalValidation = {
        redirectToProvider          = "azureActiveDirectory"
        unauthenticatedClientAction = "RedirectToLoginPage"
      }

      # Only a single identity provider, Entra, is configured.
      # The secret synchronized from Key Vault is also used here.
      # The current tenant's ID serves as the issuer, limiting access to 
      # (a subset of) users from the current tenant.
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            clientId                = data.azurerm_key_vault_secret.entra_clientid.value
            clientSecretSettingName = "jcms-entra-clientsecret"
            openIdIssuer            = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"
          }
          validation = {
            defaultAuthorizationPolicy = {
              allowedApplications = [

                # This thing lets the App Registration to authorize
                # users to the application.
                data.azurerm_key_vault_secret.entra_clientid.value
              ]
            }
          }
        }
      }
      ...
    }
  }
}
```

Finally, the App Registration's redirect URIs are updated (in case the `authConfigs` resource was created or recreated), using the same hash-set approach as before. This time, the actual Container App's EasyAuth AAD redirect URI is enforced instead of the localhost one. Note that at this stage, the GitHub Actions–associated Service Principal requires owner privileges:

```hcl
resource "null_resource" "app_redirect_uris" {

  # This lifecycle ensures that the redirect URIs are updated in the 
  # App Registration only when necessary — that is, when the Container App 
  # is (re-)created and receives a new external ingress URL.
  lifecycle {
    replace_triggered_by = [azurerm_container_app.ca_jcmsui]
  }
  triggers = {
    command = <<-EOT
      $redirectUris = @{ "https://${azurerm_container_app.ca_jcmsui.ingress[0].fqdn}/.auth/login/aad/callback" = $true }

      $appRegDetails = (az ad app show --id "${data.azurerm_key_vault_secret.entra_clientid.value}" | ConvertFrom-Json)

      foreach ($uri in $appRegDetails.web.redirectUris) {
        $redirectUris[$uri] = $true
      }

      az ad app update `
        --id "${data.azurerm_key_vault_secret.entra_clientid.value}" `
        --web-redirect-uris $redirectUris.Keys `
        --output "none"
    EOT
  }

  provisioner "local-exec" {
    command     = self.triggers.command
    interpreter = ["pwsh", "-Command"]
  }
}
```

And just like that, a few hours of automation saved a few minutes of manual clicking. Happy coding!