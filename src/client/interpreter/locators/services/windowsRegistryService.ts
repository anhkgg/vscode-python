import * as fs from 'fs-extra';
import * as _ from 'lodash';
import * as path from 'path';
import { Uri } from 'vscode';
import { Architecture, Hive, IRegistry } from '../../../common/platform/registry';
import { IInterpreterLocatorService, PythonInterpreter } from '../../contracts';

// tslint:disable-next-line:variable-name
const DefaultPythonExecutable = 'python.exe';
// tslint:disable-next-line:variable-name
const CompaniesToIgnore = ['PYLAUNCHER'];
// tslint:disable-next-line:variable-name
const PythonCoreCompanyDisplayName = 'Python Software Foundation';
// tslint:disable-next-line:variable-name
const PythonCoreComany = 'PYTHONCORE';

type CompanyInterpreter = {
    companyKey: string,
    hive: Hive,
    arch?: Architecture
};

export class WindowsRegistryService implements IInterpreterLocatorService {
    constructor(private registry: IRegistry, private is64Bit: boolean) {

    }
    // tslint:disable-next-line:variable-name
    public getInterpreters(_resource?: Uri) {
        return this.getInterpretersFromRegistry();
    }
    // tslint:disable-next-line:no-empty
    public dispose() { }
    private async getInterpretersFromRegistry() {
        // https://github.com/python/peps/blob/master/pep-0514.txt#L357
        const hkcuArch = this.is64Bit ? undefined : Architecture.x86;
        const promises: Promise<CompanyInterpreter[]>[] = [
            this.getCompanies(Hive.HKCU, hkcuArch),
            this.getCompanies(Hive.HKLM, Architecture.x86)
        ];
        // https://github.com/Microsoft/PTVS/blob/ebfc4ca8bab234d453f15ee426af3b208f3c143c/Python/Product/Cookiecutter/Shared/Interpreters/PythonRegistrySearch.cs#L44
        if (this.is64Bit) {
            promises.push(this.getCompanies(Hive.HKLM, Architecture.x64));
        }

        const companies = await Promise.all<CompanyInterpreter[]>(promises);
        // tslint:disable-next-line:underscore-consistent-invocation
        const companyInterpreters = await Promise.all(_.flatten(companies)
            .filter(item => item !== undefined && item !== null)
            .map(company => {
                return this.getInterpretersForCompany(company.companyKey, company.hive, company.arch);
            }));

        // tslint:disable-next-line:underscore-consistent-invocation
        return _.flatten(companyInterpreters)
            .filter(item => item !== undefined && item !== null)
            // tslint:disable-next-line:no-non-null-assertion
            .map(item => item!)
            .reduce<PythonInterpreter[]>((prev, current) => {
                if (prev.findIndex(item => item.path.toUpperCase() === current.path.toUpperCase()) === -1) {
                    prev.push(current);
                }
                return prev;
            }, []);
    }
    private async getCompanies(hive: Hive, arch?: Architecture): Promise<CompanyInterpreter[]> {
        return this.registry.getKeys('\\Software\\Python', hive, arch)
            .then(companyKeys => companyKeys
                .filter(companyKey => CompaniesToIgnore.indexOf(path.basename(companyKey).toUpperCase()) === -1)
                .map(companyKey => {
                    return { companyKey, hive, arch };
                }));
    }
    private async getInterpretersForCompany(companyKey: string, hive: Hive, arch?: Architecture) {
        const tagKeys = await this.registry.getKeys(companyKey, hive, arch);
        return Promise.all(tagKeys.map(tagKey => this.getInreterpreterDetailsForCompany(tagKey, companyKey, hive, arch)));
    }
    private getInreterpreterDetailsForCompany(tagKey: string, companyKey: string, hive: Hive, arch?: Architecture): Promise<PythonInterpreter | undefined | null> {
        const key = `${tagKey}\\InstallPath`;
        type InterpreterInformation = null | undefined | {
            installPath: string,
            executablePath?: string,
            displayName?: string,
            version?: string,
            companyDisplayName?: string
        };
        return this.registry.getValue(key, hive, arch)
            .then(installPath => {
                // Install path is mandatory.
                if (!installPath) {
                    return Promise.resolve(null);
                }
                // Check if 'ExecutablePath' exists.
                // Remember Python 2.7 doesn't have 'ExecutablePath' (there could be others).
                // Treat all other values as optional.
                return Promise.all([
                    Promise.resolve(installPath),
                    this.registry.getValue(key, hive, arch, 'ExecutablePath'),
                    // tslint:disable-next-line:no-non-null-assertion
                    this.getInterpreterDisplayName(tagKey, companyKey, hive, arch),
                    this.registry.getValue(tagKey, hive, arch, 'Version'),
                    this.getCompanyDisplayName(companyKey, hive, arch)
                ])
                    .then(([installedPath, executablePath, displayName, version, companyDisplayName]) => {
                        // tslint:disable-next-line:prefer-type-cast
                        return { installPath: installedPath, executablePath, displayName, version, companyDisplayName } as InterpreterInformation;
                    });
            })
            .then((interpreterInfo?: InterpreterInformation) => {
                if (!interpreterInfo) {
                    return;
                }

                const executablePath = interpreterInfo.executablePath && interpreterInfo.executablePath.length > 0 ? interpreterInfo.executablePath : path.join(interpreterInfo.installPath, DefaultPythonExecutable);
                const displayName = interpreterInfo.displayName;
                const version = interpreterInfo.version ? path.basename(interpreterInfo.version) : path.basename(tagKey);
                // tslint:disable-next-line:prefer-type-cast
                return {
                    architecture: arch,
                    displayName,
                    path: executablePath,
                    version,
                    companyDisplayName: interpreterInfo.companyDisplayName
                } as PythonInterpreter;
            })
            .then(interpreter => interpreter ? fs.pathExists(interpreter.path).catch(() => false).then(exists => exists ? interpreter : null) : null)
            .catch(error => {
                console.error(`Failed to retrieve interpreter details for company ${companyKey},tag: ${tagKey}, hive: ${hive}, arch: ${arch}`);
                console.error(error);
                return null;
            });
    }
    private async getInterpreterDisplayName(tagKey: string, companyKey: string, hive: Hive, arch?: Architecture) {
        const displayName = await this.registry.getValue(tagKey, hive, arch, 'DisplayName');
        if (displayName && displayName.length > 0) {
            return displayName;
        }
    }
    private async  getCompanyDisplayName(companyKey: string, hive: Hive, arch?: Architecture) {
        const displayName = await this.registry.getValue(companyKey, hive, arch, 'DisplayName');
        if (displayName && displayName.length > 0) {
            return displayName;
        }
        const company = path.basename(companyKey);
        return company.toUpperCase() === PythonCoreComany ? PythonCoreCompanyDisplayName : company;
    }
}
